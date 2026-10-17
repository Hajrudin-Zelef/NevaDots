import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
// A single failed control poll is usually a network flap, not a dead call.
// Only treat the control connection as lost after this many consecutive
// poll failures, mirroring the grace period #26 gives the peer connection.
const CONTROL_POLL_FAILURE_LIMIT = 3;
/** Reconnexion auto après une coupure (D4) : 5 tentatives max, backoff
 * croissant, indicateur « Reconnexion… (n/5) ». Plafond strict : pas de
 * boucle infinie, l'épuisement termine l'appel normalement (reçu posté). */
export const VOICE_MAX_RECONNECTS = 5;
export function reconnectDelayMs(attempt: number): number {
  return [1000, 2000, 4000, 8000, 16000][Math.min(Math.max(attempt, 1), 5) - 1];
}
export function useVoice(
  threadId: string,
  onSaved: () => void,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const generation = useRef(0);
  const connecting = useRef(false);
  const ending = useRef(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>(
    'listening',
  );
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  // Reconnexion auto : compteur borné + état d'indicateur. Le transcript
  // survit aux rejoins via carryTranscript (reçu final complet).
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [unsentReceipt, setUnsentReceipt] = useState<{
    id: string;
    transcript: string[];
  } | null>(null);
  const reconnects = useRef(0);
  const carryTranscript = useRef<string[]>([]);
  // Invalide les reprises en vol (fin manuelle, nouveau démarrage, démontage
  // via generation).
  const rejoinToken = useRef(0);
  // Pointeur stable vers la reprise : l'effect de contrôle tourne avant la
  // définition de rejoin, il ne peut pas le référencer directement (TDZ).
  const rejoinRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const session = useRef<
    | {
        pc: RTCPeerConnection;
        stream: MediaStream;
        audio: HTMLAudioElement;
        id?: string;
        channel: RTCDataChannel;
        transcript: string[];
        timer?: ReturnType<typeof setTimeout>;
        controlPollFailures: number;
        disconnectTimer?: ReturnType<typeof setTimeout>;
        cancelled: boolean;
      }
    | undefined
  >(undefined);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;
  const closeMedia = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    current.stream.getTracks().forEach((track) => track.stop());
    current.channel.close();
    current.pc.close();
    current.audio.pause();
    current.audio.srcObject = null;
    clearTimeout(current.timer);
    clearTimeout(current.disconnectTimer);
  }, []);
  const end = useCallback(async () => {
    if (ending.current) return;
    rejoinToken.current += 1;
    generation.current++;
    connecting.current = false;
    const current = session.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    // Silence the call immediately, while keeping the peer alive until the
    // provider confirms hangup through the server.
    current.cancelled = true;
    current.stream.getTracks().forEach((track) => {
      track.enabled = false;
    });
    current.audio.pause();
    clearTimeout(current.timer);
    clearTimeout(current.disconnectTimer);
    ending.current = true;
    setStatus('ending');
    try {
      if (current.id)
        await api(`/voice/calls/${current.id}/end`, 'POST', {
          transcript: current.transcript.join('\n').slice(0, 20000),
          anchorMessageId: anchor.current,
        });
      onSaved();
    } catch (e) {
      // Reçu non posté : transcript conservé pour renvoi manuel (rien perdu).
      if (current.id)
        setUnsentReceipt({ id: current.id, transcript: current.transcript });
      setError(
        e instanceof Error
          ? e.message
          : 'Call ended, but its receipt could not be saved.',
      );
    } finally {
      closeMedia();
      session.current = undefined;
      ending.current = false;
      setStatus('idle');
      setReconnecting(false);
      setReconnectAttempt(0);
    }
  }, [closeMedia, onSaved]);
  useEffect(
    () => () => {
      generation.current++;
      rejoinToken.current += 1;
      const current = session.current;
      closeMedia();
      if (current?.id && !ending.current)
        void fetch(`/api/voice/calls/${current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            transcript: current.transcript.join('\n').slice(0, 20000),
            anchorMessageId: anchor.current,
          }),
          keepalive: true,
        }).catch(() => {});
    },
    [closeMedia],
  );
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;
    const timer = setInterval(() => {
      const current = session.current;
      const id = current?.id;
      if (id)
        void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
          .then((call) => {
            if (session.current !== current) return;
            if (call.endedAt) {
              void end();
              return;
            }
            current.controlPollFailures = 0;
          })
          .catch(() => {
            if (session.current !== current) return;
            current.controlPollFailures += 1;
            if (current.controlPollFailures < CONTROL_POLL_FAILURE_LIMIT)
              return;
            // Perte du contrôle : reprise auto bornée plutôt que fin sèche.
            void rejoinRef.current('control-poll');
          });
    }, 2000);
    return () => clearInterval(timer);
  }, [status, closeMedia, onSaved, end]);
  const start = useCallback(
    async (resume?: string[]) => {
      if (session.current || connecting.current || ending.current) return;
      connecting.current = true;
      const attempt = ++generation.current;
      // Démarrage manuel : on repart de zéro (pas de reprise de transcript)
      // et on invalide toute reprise en vol.
      if (resume === undefined) {
        rejoinToken.current += 1;
        carryTranscript.current = [];
        reconnects.current = 0;
        setReconnecting(false);
        setReconnectAttempt(0);
        setUnsentReceipt(null);
      }
      setStatus('connecting');
      setError('');
      setMuted(false);
      setSpeakerMuted(false);
      setStartedAt(undefined);
      setPhase('listening');
      setCaption('');
      setUserCaption('');
      let stream: MediaStream | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (attempt !== generation.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const pc = new RTCPeerConnection();
        const audio = new Audio();
        audio.autoplay = true;
        const channel = pc.createDataChannel('oai-events');
        const current = {
          pc,
          audio,
          stream,
          channel,
          // Reprise après coupure : le transcript cumulé continue ici, le reçu
          // final reste complet.
          transcript: resume ?? [],
          cancelled: false,
          id: undefined as string | undefined,
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
          controlPollFailures: 0,
          disconnectTimer: undefined as
            ReturnType<typeof setTimeout> | undefined,
        };
        session.current = current;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream!));
        pc.ontrack = (event) => {
          if (current.cancelled) return;
          audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void audio.play().catch(() => {
            if (!current.cancelled)
              setError(
                'Audio playback was blocked. Check your browser audio permissions.',
              );
          });
        };
        pc.onconnectionstatechange = () => {
          if (current.cancelled) return;
          if (pc.connectionState === 'connected') {
            clearTimeout(current.disconnectTimer);
            current.disconnectTimer = undefined;
            setStatus('active');
            setReconnecting(false);
            setReconnectAttempt(0);
            setStartedAt((value) => value ?? Date.now());
            if (current.id)
              void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch(
                (e) => {
                  if (!current.cancelled) setError(e.message);
                },
              );
          }
          if (
            pc.connectionState === 'disconnected' &&
            !current.disconnectTimer
          ) {
            current.disconnectTimer = setTimeout(() => {
              current.disconnectTimer = undefined;
              if (current.cancelled || pc.connectionState !== 'disconnected')
                return;
              // Coupure réseau : reprise auto bornée plutôt que fin sèche.
              void rejoin('pc-disconnected');
            }, 5000);
          }
          if (pc.connectionState === 'failed') {
            void rejoin('pc-failed');
          }
        };
        channel.onmessage = async (event) => {
          if (current.cancelled) return;
          let data: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(String(event.data));
            if (!parsed || typeof parsed !== 'object') return;
            data = parsed as Record<string, unknown>;
          } catch {
            return;
          }
          if (data.type === 'input_audio_buffer.speech_started') {
            setPhase('listening');
            setCaption('');
          }
          if (
            data.type === 'response.output_audio_transcript.delta' &&
            typeof data.delta === 'string'
          ) {
            setPhase('speaking');
            setCaption((text) => text + data.delta);
          }
          if (data.type === 'output_audio_buffer.stopped')
            setPhase('listening');
          if (data.type === 'response.created') {
            setCaption('');
            setPhase('thinking');
          }
          if (typeof data.transcript === 'string') {
            if (
              data.type ===
              'conversation.item.input_audio_transcription.completed'
            ) {
              current.transcript.push(`You: ${data.transcript}`);
              setUserCaption(data.transcript);
            }
            if (data.type === 'response.output_audio_transcript.done')
              current.transcript.push(`Dot: ${data.transcript}`);
          }
          if (data.type === 'error')
            setError(
              'The voice provider reported a session error. End the call and retry.',
            );
          if (
            data.type !== 'response.function_call_arguments.done' ||
            data.name !== 'ask_compute' ||
            typeof data.call_id !== 'string' ||
            !current.id
          )
            return;
          let output: string;
          setPhase('thinking');
          try {
            const args: unknown = JSON.parse(String(data.arguments));
            if (
              !args ||
              typeof args !== 'object' ||
              !('request' in args) ||
              typeof args.request !== 'string'
            )
              throw new Error('Invalid compute request.');
            const result = await api<{ text: string }>(
              `/voice/calls/${current.id}/compute`,
              'POST',
              {
                toolCallId: data.call_id,
                request: args.request,
                transcript: current.transcript.join('\n').slice(-12000),
              },
            );
            output = result.text;
          } catch (e) {
            output = `Compute failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
          }
          if (!current.cancelled && channel.readyState === 'open') {
            channel.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: data.call_id,
                  output,
                },
              }),
            );
            channel.send(JSON.stringify({ type: 'response.create' }));
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await api<{ id: string; sdp: string }>(
          '/voice/calls',
          'POST',
          { threadId, sdp: offer.sdp },
        );
        current.id = response.id;
        if (current.cancelled) {
          await api(`/voice/calls/${response.id}/end`, 'POST', {
            transcript: '',
          });
          return;
        }
        await pc.setRemoteDescription({ type: 'answer', sdp: response.sdp });
        if (current.cancelled) return;
        current.timer = setTimeout(() => void end(), 15 * 60_000);
      } catch (e) {
        if (attempt !== generation.current) {
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }
        const current = session.current;
        const id = current?.id;
        if (id)
          void api(`/voice/calls/${id}/end`, 'POST', {
            transcript: '',
            anchorMessageId: anchor.current,
          }).catch(() => {});
        stream?.getTracks().forEach((track) => track.stop());
        closeMedia();
        session.current = undefined;
        setStatus('idle');
        setError(
          e instanceof Error ? e.message : 'Could not connect the call.',
        );
      } finally {
        if (attempt === generation.current) connecting.current = false;
      }
    },
    [threadId, closeMedia],
  );
  const toggleMute = () => {
    const next = !muted;
    session.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  };
  /**
   * Reprise après coupure (D4) : ferme la session morte SANS poster de reçu
   * (l'appel continue) et relance start() avec le transcript cumulé, jusqu'à
   * VOICE_MAX_RECONNECTS. À épuisement : fin normale avec reçu complet.
   */
  const rejoin = useCallback(
    async (reason: string) => {
      const current = session.current;
      if (!current || current.cancelled || ending.current) return;
      if (reconnects.current >= VOICE_MAX_RECONNECTS) {
        setError(
          `Connexion vocale perdue (${reason}) après ${VOICE_MAX_RECONNECTS} tentatives.`,
        );
        await end();
        return;
      }
      reconnects.current += 1;
      const n = reconnects.current;
      const token = rejoinToken.current;
      // `current.transcript` est déjà le transcript complet (initialisé depuis
      // carryTranscript au démarrage/rejoin et accumulé depuis) : on remplace,
      // on n'ajoute pas — sinon la 2e reprise dupliquerait les lignes portées.
      carryTranscript.current = [...current.transcript];
      current.cancelled = true;
      closeMedia();
      session.current = undefined;
      setReconnecting(true);
      setReconnectAttempt(n);
      setError('');
      setStatus('connecting');
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(n)));
      if (token !== rejoinToken.current) return;
      connecting.current = false;
      await start(carryTranscript.current);
    },
    [closeMedia, end, start],
  );
  // Publié après définition (voir rejoinRef ci-dessus).
  useEffect(() => {
    rejoinRef.current = rejoin;
  });
  const toggleSpeaker = () => {
    const next = !speakerMuted;
    if (session.current) session.current.audio.muted = next;
    setSpeakerMuted(next);
  };
  /** Renvoi manuel d'un reçu non posté (échec réseau à la fin d'appel). */
  const retryReceipt = useCallback(async () => {
    const pending = unsentReceipt;
    if (!pending) return;
    try {
      await api(`/voice/calls/${pending.id}/end`, 'POST', {
        transcript: pending.transcript.join('\n').slice(0, 20000),
        anchorMessageId: anchor.current,
      });
      setUnsentReceipt(null);
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Le reçu n’a pas pu être renvoyé.',
      );
    }
  }, [unsentReceipt, onSaved]);
  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    toggleMute,
    toggleSpeaker,
    reconnecting,
    reconnectAttempt,
    unsentReceipt: unsentReceipt !== null,
    retryReceipt,
  };
}

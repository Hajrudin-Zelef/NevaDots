# Dev toolchain layer on top of the pinned computer image (P4, agentic coding).
# The base stays byte-identical to upstream CopilotKit/OpenBot b6932d3; only
# this additive layer diverges.
# Built after the `computer-image` service; the supervisor runs this tag.
#
# Tools: base dev set (git, ssh, python3, build tools, ripgrep, jq, tree,
# less) + Tier 1 everyday tools (fd, bat, yq, file, zip, p7zip, zstd,
# procps, psmisc, lsof, htop, strace, git-lfs, delta, shellcheck, shfmt,
# uv, ruff) + sqlite3 + ffmpeg. See specs/computer.md.
# Install methods: apt (official Ubuntu 24.04 archives) for everything
# available there; pinned GitHub release binaries (HTTPS, official
# upstream repos) for yq / delta / shfmt / uv / ruff, which are not in the
# official Ubuntu 24.04 archives. No third-party apt repo is added.
FROM opendots-computer:b6932d3

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      python3 \
      python3-pip \
      python3-venv \
      build-essential \
      pkg-config \
      cmake \
      ripgrep \
      jq \
      tree \
      less \
      fd-find \
      bat \
      file \
      zip \
      p7zip-full \
      zstd \
      procps \
      psmisc \
      lsof \
      htop \
      strace \
      git-lfs \
      shellcheck \
      sqlite3 \
      ffmpeg \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

# Debian/Ubuntu rename fd -> fdfind and bat -> batcat (name collisions).
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/batcat /usr/local/bin/bat

# Binaries from official upstream GitHub releases, pinned versions, HTTPS.
# No checksum file: these run inside an already agent-controlled container
# (shell + network), so a binary here gains no privilege the agent does not
# already have; the pin + TLS to the official repo is the integrity control.
# yq (mikefarah, Go) — YAML processor.
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/v4.54.1/yq_linux_amd64" \
      -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# delta (dandavison, Rust) — syntax-highlighting pager for git diffs.
# Installed only; git is NOT configured to use it (the Dot opts in with
# `git config --global core.pager delta` if it wants it).
RUN curl -fsSL "https://github.com/dandavison/delta/releases/download/0.19.2/delta-0.19.2-x86_64-unknown-linux-musl.tar.gz" \
      -o /tmp/delta.tar.gz \
    && tar -xzf /tmp/delta.tar.gz -C /tmp \
    && mv /tmp/delta-0.19.2-x86_64-unknown-linux-musl/delta /usr/local/bin/delta \
    && rm -rf /tmp/delta.tar.gz /tmp/delta-0.19.2-x86_64-unknown-linux-musl

# shfmt (mvdan, Go) — shell formatter.
RUN curl -fsSL "https://github.com/mvdan/sh/releases/download/v3.8.0/shfmt_v3.8.0_linux_amd64" \
      -o /usr/local/bin/shfmt \
    && chmod +x /usr/local/bin/shfmt

# uv (astral, Rust) — fast Python package manager. Tarball extracts into
# uv-x86_64-unknown-linux-gnu/ (uv + uvx).
RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-unknown-linux-gnu.tar.gz" \
      -o /tmp/uv.tar.gz \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && mv /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/ \
    && rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu

# ruff (astral, Rust) — Python linter + formatter. Tarball extracts into
# ruff-x86_64-unknown-linux-gnu/.
RUN curl -fsSL "https://github.com/astral-sh/ruff/releases/download/0.17.1/ruff-x86_64-unknown-linux-gnu.tar.gz" \
      -o /tmp/ruff.tar.gz \
    && tar -xzf /tmp/ruff.tar.gz -C /tmp \
    && mv /tmp/ruff-x86_64-unknown-linux-gnu/ruff /usr/local/bin/ruff \
    && rm -rf /tmp/ruff.tar.gz /tmp/ruff-x86_64-unknown-linux-gnu

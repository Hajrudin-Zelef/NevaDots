# Dev toolchain layer on top of the pinned computer image (P4, agentic coding).
# The base stays byte-identical to upstream CopilotKit/OpenBot b6932d3; only
# this additive layer diverges (git, python3, build tools, ripgrep, jq, ssh).
# Built after the `computer-image` service; the supervisor runs this tag.
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
    && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

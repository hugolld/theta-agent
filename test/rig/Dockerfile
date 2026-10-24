# The clean-room rig (ADR 0005): the disposable Linux container a dogfood or
# adversarial session runs in. Digest pins keep the bytes official whichever
# registry door serves the pull; milestone boundaries re-pin them.
#
# The build context is test/rig/ alone — nothing from the repo is baked in.
# The checkout enters per run as a fresh clone of the pinned HEAD (run.mjs).

FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS python

# No apt stage: on constrained networks transparent HTTP proxies stall large
# apt transfers, and every needed tool rides an official image anyway. The
# full node image ships git and ca-certificates; bookworm python matches its
# glibc generation, so the /usr/local copy links cleanly.
FROM node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384

COPY --from=python /usr/local /usr/local

# The pi harness the package targets — exact pin, re-pinned at milestones.
RUN npm install -g @earendil-works/pi-coding-agent@1.4.0 \
	&& npm cache clean --force

# Non-root: the session inside owns its home and nothing else.
RUN useradd --create-home --shell /bin/bash theta

USER theta
WORKDIR /work

CMD ["pi", "--version"]

# syntax=docker/dockerfile:1.7
# services/media-worker on Python 3.12 with ffmpeg. Build from the repository root:
#   docker build -f services/media-worker/Dockerfile -t polycast/media-worker:<tag> .
# Built and published by `cdk deploy` as a Docker image asset (docs/aws-setup.md "Polycast stacks").

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker
WORKDIR /app
COPY services/media-worker/pyproject.toml ./
COPY services/media-worker/polycast_worker ./polycast_worker
RUN pip install .
USER worker
# ECS passes `--api-url <internal API ALB>`; API_BASE_URL is the fallback (config.py).
CMD ["python", "-m", "polycast_worker"]

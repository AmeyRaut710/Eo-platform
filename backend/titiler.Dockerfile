FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install GDAL system packages (small set) to satisfy titiler/rio deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin libgdal-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install titiler application
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install titiler.application==0.18.3

EXPOSE 8001

# Start TiTiler
CMD ["sh", "-c", "uvicorn titiler.application.main:app --host 0.0.0.0 --port ${PORT:-8001}"]

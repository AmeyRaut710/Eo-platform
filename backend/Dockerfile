FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install GDAL and PROJ dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    gdal-bin libgdal-dev libproj-dev python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python deps
COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install -r /app/requirements.txt

# Copy application code
COPY . /app

EXPOSE 8000

# Run the FastAPI backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM osgeo/gdal:ubuntu-small-3.7.2

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install Python 3 and pip
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
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

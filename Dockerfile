FROM mcr.microsoft.com/playwright:jammy

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
COPY packages ./packages
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    tzdata xvfb x11vnc fluxbox novnc websockify x11-apps xterm xrdp \
    build-essential python3 pkg-config yasm curl gnupg netcat-openbsd dbus-x11 pulseaudio \
    ffmpeg libjpeg-turbo8 libjpeg-turbo8-dev \
    xpra xauth \
    gstreamer1.0-tools gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav \
    libnss3 libxss1 libasound2 fonts-dejavu-core ca-certificates \
 && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
 && dpkg-reconfigure -f noninteractive tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g node-pre-gyp prebuild-install \
 && npm install --omit=dev \
 && npx playwright install --with-deps

# Try to upgrade xpra from upstream repository for WebRTC support if available
RUN set -eux; \
  echo "Adding Xpra upstream repository (if available)"; \
  mkdir -p /usr/share/keyrings; \
  curl -fsSL https://xpra.org/gpg.asc | gpg --dearmor -o /usr/share/keyrings/xpra.gpg || true; \
  echo "deb [signed-by=/usr/share/keyrings/xpra.gpg] https://xpra.org/ jammy main" > /etc/apt/sources.list.d/xpra.list; \
  apt-get update || true; \
  apt-get install -y --no-install-recommends xpra || true; \
  rm -rf /var/lib/apt/lists/* || true

# Copy the app
COPY . .

# Provide XRDP configuration to mirror the existing :0 desktop via VNC
COPY configs/xrdp.ini /etc/xrdp/xrdp.ini

ENV NODE_ENV=production
EXPOSE 3333

# Startup script: launch virtual display + VNC and then the web server
COPY start.sh ./start.sh
RUN chmod +x ./start.sh
CMD ["/bin/bash", "./start.sh"]

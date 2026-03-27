FROM ghcr.io/hoytech/strfry:latest

# Switch to root to install Node.js (fiatjaf image is based on alpine or ubuntu, we try both package managers safely)
USER root
RUN (apt-get update && apt-get install -y nodejs) || (apk update && apk add nodejs)

# Switch back
# Run with default user (root) to ensure node/strfry permissions

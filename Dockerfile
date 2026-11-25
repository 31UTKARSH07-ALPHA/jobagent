FROM node:25.2.1-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /state && chown node:node /state
USER node
ENV JOBAGENT_DASHBOARD_MODE=hosted \
    JOBAGENT_DASHBOARD_BIND=0.0.0.0 \
    JOBAGENT_DASHBOARD_PORT=8080 \
    JOBAGENT_DB=/state/jobagent.db \
    JOBAGENT_SEND=disarmed
VOLUME ["/state"]
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/dashboard/server.ts"]

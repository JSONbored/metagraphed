# Postgres -> R2 backup job (ADR 0013). postgres:17-alpine gives pg_dump 17
# (dumps PG 16/17 servers); aws-cli streams to R2's S3 API. Build context = repo
# root (set the Railway service Config File to /deploy/backup.railway.json).
#   docker build -f deploy/backup/Dockerfile -t metagraphed-pg-backup .
FROM postgres:17-alpine
RUN apk add --no-cache aws-cli
COPY deploy/backup/backup-postgres.sh /usr/local/bin/backup-postgres.sh
RUN chmod +x /usr/local/bin/backup-postgres.sh
# Override the postgres image entrypoint (which would try to start a server) so
# the container just runs the backup script and exits.
ENTRYPOINT ["/usr/local/bin/backup-postgres.sh"]

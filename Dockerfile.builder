# Railrunner builder — the runner plus Buildah, for building container images
# WITHOUT a Docker daemon. Configured for the most locked-down case: rootless,
# vfs storage (no overlay), chroot isolation (no OCI runtime). Whether Railway's
# sandbox permits even this depends on it allowing unprivileged user namespaces —
# a single probe build confirms it (see the README).
FROM ghcr.io/actions/actions-runner:latest

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends buildah uidmap slirp4netns ca-certificates \
 && printf 'runner:100000:65536\n' > /etc/subuid \
 && printf 'runner:100000:65536\n' > /etc/subgid \
 && buildah --version \
 && rm -rf /var/lib/apt/lists/*

# Defaults that let plain `buildah bud` work in an unprivileged container.
ENV STORAGE_DRIVER=vfs \
    BUILDAH_ISOLATION=chroot

COPY --chmod=755 entrypoint.sh /home/runner/entrypoint.sh
USER runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]

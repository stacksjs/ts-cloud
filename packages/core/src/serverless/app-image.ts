/**
 * Generates the application container-image Dockerfile for serverless apps that
 * exceed the 250 MB zip/layer limit (`packaging: 'image'`). Lambda runs the
 * image directly (up to 10 GB).
 *
 * - Node/Bun: FROM the AWS Lambda Node base image; the bundled handler is copied
 *   to the task root and the function's `ImageConfig.Command` selects the export.
 * - PHP: a self-contained multi-stage build — stage 1 compiles + relocates PHP
 *   (the same recipe as the runtime layer), stage 2 is the `provided.al2023`
 *   base with /opt (runtime) + /var/task (app) baked in; the bootstrap selects
 *   the mode from `TSCLOUD_LAMBDA_MODE`.
 */
import { phpLayerBuildStage } from '../serverless-php/dockerfile'

export interface AppImageDockerfileOptions {
  kind: 'node' | 'bun' | 'php'
  /** Node runtime tag (e.g. '20') — used for the Lambda Node base image. */
  nodeMajor?: string
  /** PHP version for the runtime build stage (kind: 'php'). @default '8.3' */
  phpVersion?: string
  /** CPU architecture (documented; the build uses --platform at build time). */
  architecture?: 'x86_64' | 'arm64'
}

export function generateAppImageDockerfile(options: AppImageDockerfileOptions): string {
  if (options.kind === 'php') {
    const phpVersion = options.phpVersion ?? '8.3'
    // Runtime assets (bootstrap etc.) are staged at ./runtime; app at ./app.
    return `# ts-cloud serverless PHP app image (generated, multi-stage).
${phpLayerBuildStage(phpVersion, 'phpbuild')}

FROM public.ecr.aws/lambda/provided:al2023
# Bake the relocated PHP runtime from the build stage.
COPY --from=phpbuild /opt/ /opt/
# ts-cloud runtime assets (bootstrap, runtime loops, fpm config).
COPY runtime/ /opt/
# The application source tree.
COPY app/ /var/task/
# /opt/bootstrap is the runtime entrypoint; mode comes from TSCLOUD_LAMBDA_MODE.
ENTRYPOINT [ "/opt/bootstrap" ]
`
  }

  const nodeMajor = options.nodeMajor ?? '20'
  return `# ts-cloud serverless Node app image (generated).
FROM public.ecr.aws/lambda/nodejs:${nodeMajor}

# The bundled handler artifact (index.mjs) at the Lambda task root.
COPY app/ \${LAMBDA_TASK_ROOT}/

# Per-function CMD (e.g. index.http) is supplied via ImageConfig.Command.
CMD [ "index.http" ]
`
}

# Same Node 26 Lambda base image as apps/bff — the image *is* the runtime,
# so this isn't gated on aws-cdk-lib growing a NODEJS_26_X enum. Tag is
# `26-preview` until AWS GA (~Nov 2026); identifier/image stay Node 26.
FROM public.ecr.aws/lambda/nodejs:26-preview

COPY index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]

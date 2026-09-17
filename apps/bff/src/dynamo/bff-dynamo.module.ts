import { Global, Module } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '@bubltec/mycota-dynamo';

/** Same as mycota DynamoModule, plus convertClassInstanceToMap for ValidationPipe DTO writes. */
@Global()
@Module({
  providers: [
    {
      provide: DYNAMO_DOC_CLIENT,
      useFactory: () => {
        const endpoint = process.env.DYNAMODB_ENDPOINT;
        const client = new DynamoDBClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          ...(endpoint
            ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
            : {}),
        });
        return DynamoDBDocumentClient.from(client, {
          marshallOptions: {
            removeUndefinedValues: true,
            convertClassInstanceToMap: true,
          },
        });
      },
    },
  ],
  exports: [DYNAMO_DOC_CLIENT],
})
export class BffDynamoModule {}

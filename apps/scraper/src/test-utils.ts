import { mockClient } from 'aws-sdk-client-mock';

/** aws-sdk-client-mock + mixed @smithy/types versions from AgentCore vs Dynamo. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mockAws<T>(client: T): any {
  return mockClient(client as never);
}

import { mockClient } from 'aws-sdk-client-mock';

/** aws-sdk-client-mock + mixed @smithy/types versions from AgentCore vs Dynamo. */
export function mockAws<T>(client: T): any {
  return mockClient(client as never);
}

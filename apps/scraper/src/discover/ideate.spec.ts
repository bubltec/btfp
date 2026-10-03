import { describe, expect, it } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockAws } from '../test-utils.js';
import { ideateTopics, ideationFocuses, nextIdeationFocus } from './ideate.js';

const taxonomy = { thingTypeIds: ['plant', 'food'], petTypeIds: ['dog', 'cat', 'unknown'] };

function reply(names: string[]) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't', name: 'suggest_hazards', input: { names } } }],
      },
    },
  };
}

describe('ideationFocuses', () => {
  it('pairs every thing type with every pet type in a stable order, without "unknown"', () => {
    expect(ideationFocuses(taxonomy)).toEqual([
      { thingTypeId: 'food', petTypeId: 'cat' },
      { thingTypeId: 'food', petTypeId: 'dog' },
      { thingTypeId: 'plant', petTypeId: 'cat' },
      { thingTypeId: 'plant', petTypeId: 'dog' },
    ]);
  });
});

describe('nextIdeationFocus', () => {
  const focuses = ideationFocuses(taxonomy);
  const client = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));

  it('starts at the first focus and stores where it is', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(GetCommand).resolves({});
    db.on(PutCommand).resolves({});
    expect(await nextIdeationFocus(client(), focuses)).toEqual(focuses[0]);
    expect(db.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      PK: 'SCRAPERIDEA#CURSOR',
      SK: 'META',
      index: 0,
    });
  });

  it('moves on from the stored position and wraps around', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    db.on(PutCommand).resolves({});
    db.on(GetCommand).resolves({ Item: { index: 1 } });
    expect(await nextIdeationFocus(client(), focuses)).toEqual(focuses[2]);
    db.on(GetCommand).resolves({ Item: { index: 3 } });
    expect(await nextIdeationFocus(client(), focuses)).toEqual(focuses[0]);
  });

  it('has nothing to offer for an empty taxonomy', async () => {
    const db = mockAws(DynamoDBDocumentClient);
    expect(await nextIdeationFocus(client(), [])).toBeUndefined();
    expect(db.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe('ideateTopics', () => {
  const focus = { thingTypeId: 'plant', petTypeId: 'cat' };
  const bedrock = () => new BedrockRuntimeClient({});

  it('tells the model the focus and what is covered, and drops covered or repeated names', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).resolves(reply(['Oleander', 'sago palm', 'oleander', 'Foxglove', 'x']));
    const names = await ideateTopics(bedrock(), 'm', {
      focus,
      thingTypeName: 'Plant',
      petTypeName: 'Cat',
      covered: ['Sago Palm', 'Lily', 'Lily'],
      count: 5,
    });
    expect(names).toEqual(['Oleander', 'Foxglove']);
    const prompt =
      aws.commandCalls(ConverseCommand)[0]?.args[0].input.messages?.[0]?.content?.[0]?.text;
    expect(prompt).toBe(
      'Thing type: Plant\nPet: Cat\nSuggest up to 5.\n\nAlready covered:\n- Sago Palm\n- Lily',
    );
  });

  it('returns no more than it was asked for', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).resolves(reply(['Oleander', 'Foxglove', 'Yew']));
    expect(await ideateTopics(bedrock(), 'm', { focus, covered: [], count: 2 })).toEqual([
      'Oleander',
      'Foxglove',
    ]);
  });

  it('suggests nothing on a Bedrock error, and makes no call when there is no room', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).rejects(new Error('throttled'));
    expect(await ideateTopics(bedrock(), 'm', { focus, covered: [], count: 3 })).toEqual([]);
    expect(await ideateTopics(bedrock(), 'm', { focus, covered: [], count: 0 })).toEqual([]);
    expect(aws.commandCalls(ConverseCommand)).toHaveLength(1);
  });
});

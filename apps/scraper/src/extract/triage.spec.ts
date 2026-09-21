import { describe, expect, it } from 'vitest';
import { mockAws } from '../test-utils.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { triageTopics } from './triage.js';

function reply(yes: string[], no: string[] = []) {
  const decisions = [
    ...yes.map((topic) => ({ topic, reason: 'r', couldHarmDogOrCat: true })),
    ...no.map((topic) => ({ topic, reason: 'r', couldHarmDogOrCat: false })),
  ];
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't', name: 'judge_topics', input: { decisions } } }],
      },
    },
  };
}

describe('triageTopics', () => {
  it('keeps only terms it was given, ignoring anything the model invents', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves(reply(['Sago Palm', 'invented topic'], ['nfl scores']));
    const kept = await triageTopics(new BedrockRuntimeClient({}), 'm', ['nfl scores', 'sago palm']);
    expect(kept).toEqual(['Sago Palm']);
  });

  it('fails closed on a Bedrock error and skips the call for an empty list', async () => {
    const bedrock = mockAws(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).rejects(new Error('throttled'));
    expect(await triageTopics(new BedrockRuntimeClient({}), 'm', ['x'])).toEqual([]);
    expect(await triageTopics(new BedrockRuntimeClient({}), 'm', [])).toEqual([]);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockAws } from './test-utils.js';
import type { MemoryStore, RecalledResearch } from './memory/types.js';
import {
  SIMILARITY_FLOOR,
  assessNovelty,
  judgeDuplicates,
  type AmbiguousTopic,
  type DuplicateJudge,
} from './novelty.js';

function recalled(term: string, score: number, name?: string): RecalledResearch {
  return { term, name, outcome: 'filed', summary: '', score };
}

function memoryWith(byQuery: Record<string, RecalledResearch[]>): MemoryStore {
  return {
    recall: async (query) => byQuery[query] ?? [],
    remember: async () => undefined,
  };
}

const bedrock = () => new BedrockRuntimeClient({});

describe('assessNovelty', () => {
  it('calls an exact term or hazard-name match a duplicate without asking the model', async () => {
    const judge = vi.fn<DuplicateJudge>(async () => new Map());
    const memory = memoryWith({
      'Sago Palms': [recalled('sago palm', 0.54)],
      xylitol: [recalled('birch sugar', 0.4, 'Xylitol')],
    });
    expect(await assessNovelty(memory, judge, bedrock(), 'm', ['Sago Palms', 'xylitol'])).toEqual([
      { term: 'Sago Palms', duplicateOf: 'sago palm' },
      { term: 'xylitol', duplicateOf: 'birch sugar' },
    ]);
    expect(judge).not.toHaveBeenCalled();
  });

  it('calls a topic new without asking when nothing recalled is similar enough', async () => {
    const judge = vi.fn<DuplicateJudge>(async () => new Map());
    const memory = memoryWith({ chocolate: [recalled('xylitol', SIMILARITY_FLOOR - 0.01)] });
    expect(await assessNovelty(memory, judge, bedrock(), 'm', ['chocolate', 'lilies'])).toEqual([
      { term: 'chocolate' },
      { term: 'lilies' },
    ]);
    expect(judge).not.toHaveBeenCalled();
  });

  it('asks once about everything in between, with only the similar records', async () => {
    const judge = vi.fn<DuplicateJudge>(async () => new Map([['Advil', 'ibuprofen']]));
    const memory = memoryWith({
      Advil: [recalled('ibuprofen', 0.383), recalled('xylitol', 0.336)],
      tea: [recalled('tea tree oil', 0.379)],
      chocolate: [],
    });
    expect(
      await assessNovelty(memory, judge, bedrock(), 'm', ['Advil', 'chocolate', 'tea']),
    ).toEqual([
      { term: 'Advil', duplicateOf: 'ibuprofen' },
      { term: 'chocolate' },
      { term: 'tea' },
    ]);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[2]).toEqual([
      { term: 'Advil', similar: [recalled('ibuprofen', 0.383)] },
      { term: 'tea', similar: [recalled('tea tree oil', 0.379)] },
    ]);
  });
});

describe('judgeDuplicates', () => {
  const topics: AmbiguousTopic[] = [
    { term: 'Advil', similar: [recalled('ibuprofen', 0.383, 'Ibuprofen')] },
    { term: 'tea', similar: [recalled('tea tree oil', 0.379)] },
  ];

  function reply(decisions: { candidate: string; sameAs: string | null }[]) {
    return {
      output: {
        message: {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 't', name: 'judge_duplicates', input: { decisions } } },
          ],
        },
      },
    };
  }

  it('shows the model each candidate with its earlier topics and maps the duplicates', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).resolves(
      reply([
        { candidate: 'Advil', sameAs: 'ibuprofen' },
        { candidate: 'tea', sameAs: null },
      ]),
    );
    expect(await judgeDuplicates(bedrock(), 'm', topics)).toEqual(
      new Map([['Advil', 'ibuprofen']]),
    );
    const prompt =
      aws.commandCalls(ConverseCommand)[0]?.args[0].input.messages?.[0]?.content?.[0]?.text;
    expect(prompt).toContain(
      'Candidate: Advil\nEarlier topics:\n- ibuprofen (hazard: Ibuprofen; outcome: filed)',
    );
    expect(prompt).toContain('Candidate: tea\nEarlier topics:\n- tea tree oil (outcome: filed)');
  });

  it('accepts only an earlier topic that was shown for that candidate', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).resolves(
      reply([
        { candidate: 'Advil', sameAs: 'tea tree oil' },
        { candidate: 'tea', sameAs: 'green tea' },
        { candidate: 'invented', sameAs: 'ibuprofen' },
      ]),
    );
    expect(await judgeDuplicates(bedrock(), 'm', topics)).toEqual(new Map());
  });

  it('treats everything as new on a Bedrock error, and makes no call for an empty list', async () => {
    const aws = mockAws(BedrockRuntimeClient);
    aws.on(ConverseCommand).rejects(new Error('throttled'));
    expect(await judgeDuplicates(bedrock(), 'm', topics)).toEqual(new Map());
    expect(await judgeDuplicates(bedrock(), 'm', [])).toEqual(new Map());
    expect(aws.commandCalls(ConverseCommand)).toHaveLength(1);
  });
});

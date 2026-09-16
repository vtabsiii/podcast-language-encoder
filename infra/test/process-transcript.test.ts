import { extractTranscriptText, chunkByBytes } from '../lambda/process-transcript/index';

describe('extractTranscriptText', () => {
  test('joins transcript segments from a Transcribe output document', () => {
    const doc = JSON.stringify({
      results: { transcripts: [{ transcript: 'Hello world.' }, { transcript: 'Bye.' }] },
    });
    expect(extractTranscriptText(doc)).toBe('Hello world. Bye.');
  });

  test('throws on an empty document', () => {
    expect(() => extractTranscriptText('{"results":{"transcripts":[]}}')).toThrow(/no text/);
  });
});

describe('chunkByBytes', () => {
  test('keeps short text as one chunk', () => {
    expect(chunkByBytes('One. Two. Three.', 100)).toEqual(['One. Two. Three.']);
  });

  test('splits on sentence boundaries under the byte limit', () => {
    const chunks = chunkByBytes('Aaaa aaaa. Bbbb bbbb. Cccc cccc.', 22);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(22);
    expect(chunks.join(' ')).toBe('Aaaa aaaa. Bbbb bbbb. Cccc cccc.');
  });

  test('hard-splits a single oversized sentence', () => {
    const chunks = chunkByBytes('x'.repeat(50), 20);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 10]);
  });
});

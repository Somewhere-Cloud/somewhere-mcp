import { buildAdvisorInput } from './advisor-boundary';
import { ADVISOR_COMPOSITION_FORMAT } from './advisor-composition';
import { ADVISOR_MAX_OUTPUT_TOKENS } from './advisor-model-profile';
import { selectAdvisorKnowledge, type AdvisorKnowledge } from './advisor-knowledge';

/** Pure one-shot request construction; caller data supplies no executable authority. */
export function buildAdvisorRequestBody(
  model: string, system: string, question: string, untrustedContext: string | null,
  promptCacheKey: string, serviceTier: 'flex' | 'default',
) {
  return {
    model,
    reasoning: { effort: 'none' as const },
    text: { verbosity: 'low' as const, format: ADVISOR_COMPOSITION_FORMAT },
    input: buildAdvisorInput(system, question, untrustedContext),
    prompt_cache_key: promptCacheKey,
    service_tier: serviceTier,
    max_output_tokens: ADVISOR_MAX_OUTPUT_TOKENS,
  };
}

export type AdvisorRequestBody = ReturnType<typeof buildAdvisorRequestBody>;

/** Pricing questions use bundled contracts; personalized facts still require explicit input. */
export function selectAdvisorRequestKnowledge(
  question: string,
  topics: Parameters<typeof selectAdvisorKnowledge>[1],
  tools: Parameters<typeof selectAdvisorKnowledge>[2],
  options: Parameters<typeof selectAdvisorKnowledge>[3] = {},
): AdvisorKnowledge {
  const retrievalQuestion = /\b(?:plans?|pricing|prices?|costs?|limits?)\b/i.test(question)
    ? `${question}\npricing` : question;
  return selectAdvisorKnowledge(retrievalQuestion, topics, tools, options);
}

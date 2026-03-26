'use strict';

// --- Keyword-Based Categorization ---

const CATEGORY_KEYWORDS = {
  todo: ['need to', 'have to', 'should', 'must', 'remember to', 'got to', 'gotta', 'task', 'to do', 'to-do', 'make sure'],
  idea: ['what if', 'idea', 'maybe we', 'could try', 'how about', 'brainstorm', 'concept', 'imagine', 'we could', 'possibility'],
  question: ['how do', 'what is', 'why does', 'when will', 'where can', 'who is', 'i wonder', 'figure out', 'not sure', 'how come'],
  reminder: ['tomorrow', 'next week', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'appointment', 'pick up', "don't forget", 'schedule'],
  work: ['meeting', 'project', 'client', 'email', 'deadline', 'presentation', 'report', 'office', 'team', 'manager', 'colleague', 'boss', 'coworker'],
  personal: ['family', 'friend', 'birthday', 'vacation', 'dinner', 'weekend', 'kids', 'wife', 'husband', 'parents', 'mom', 'dad'],
  health: ['doctor', 'exercise', 'workout', 'sleep', 'headache', 'medication', 'medicine', 'symptom', 'diet', 'gym', 'pharmacy'],
  finance: ['payment', 'budget', 'invoice', 'expense', 'price', 'cost', 'money', 'bill', 'bank', 'credit', 'debt', 'salary', 'rent']
};

export { CATEGORY_KEYWORDS };

export function categorizeNote(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matched = [];
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(category);
        break;
      }
    }
  }
  return matched;
}

// --- Sentiment Analysis (Transformers.js) ---

let sentimentPipeline = null;
let pipelineLoading = null;

async function loadSentimentPipeline() {
  if (sentimentPipeline) return sentimentPipeline;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      sentimentPipeline = await pipeline(
        'sentiment-analysis',
        'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
        { dtype: 'q8' }
      );
      return sentimentPipeline;
    } catch (e) {
      console.error('Failed to load sentiment model:', e);
      pipelineLoading = null;
      return null;
    }
  })();

  return pipelineLoading;
}

export async function analyzeSentiment(text) {
  if (!text || text.trim().length === 0) {
    return { label: 'neutral', score: 0 };
  }

  try {
    const classifier = await loadSentimentPipeline();
    if (!classifier) return { label: 'neutral', score: 0 };

    const result = await classifier(text);
    const label = result[0].label.toLowerCase();
    const score = result[0].score;

    // Low-confidence results are neutral
    if (score < 0.6) {
      return { label: 'neutral', score };
    }
    return { label, score };
  } catch (e) {
    console.error('Sentiment analysis error:', e);
    return { label: 'neutral', score: 0 };
  }
}

export async function analyzeNote(text) {
  const categories = categorizeNote(text);
  const sentiment = await analyzeSentiment(text);
  return { categories, sentiment };
}

export function preloadSentimentModel() {
  loadSentimentPipeline();
}

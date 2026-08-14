#!/usr/bin/env python3
"""
HydraRecall LongMemEval QA judge -- Groq endpoint variant.

Adapted from the official LongMemEval evaluator
(https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py,
MIT License, Copyright (c) 2024 Di Wu). The answer-check prompts, per-question
voting, and reporting logic are unchanged from the official implementation. The
only substitutions are the judge endpoint (Groq's OpenAI-compatible API) and the
model entry, because this machine has no OpenAI key. Scores produced by this
script are judge-scored with a non-OpenAI judge model and must be labeled as
such (see EVALUATION.md).

Usage:
  python scripts/longmemeval-judge-groq.py <judge-model> <hyp_file> <ref_file>

Judge model (default: llama-3.3-70b-versatile):
  llama-3.3-70b-versatile, openai/gpt-oss-20b, llama-3.1-8b-instant,
  gemini-2.5-flash, gemini-3-flash, or any model id hosted by that provider.

Credentials:
  GROQ_API_KEY is used directly; if OPENAI_API_KEY is set it wins (both point
  at api.groq.com/openai/v1). For Gemini use GEMINI_API_KEY (or
  OPENAI_API_KEY pointing at the Gemini OpenAI-compatible endpoint).
"""

import os
import sys
import json
from tqdm import tqdm
import backoff
import openai
from openai import OpenAI
import numpy as np


model_zoo = {
    'gpt-4o-mini': ('gpt-4o-mini-2024-07-18', 'openai'),
    'gpt-4o': ('gpt-4o-2024-08-06', 'openai'),
    'llama-3.1-70b-instruct': ('meta-llama/Meta-Llama-3.1-70B-Instruct', 'local'),
    'llama-3.3-70b-versatile': ('llama-3.3-70b-versatile', 'groq'),
    'gemini-2.5-flash': ('gemini-2.5-flash', 'gemini'),
    'gemini-3-flash': ('gemini-3-flash', 'gemini'),
    'gemini-3.1-flash-lite': ('gemini-3.1-flash-lite', 'gemini'),
}


@backoff.on_exception(backoff.expo, (openai.RateLimitError, openai.APIError))
def chat_completions_with_backoff(client, **kwargs):
    return client.chat.completions.create(**kwargs)


def get_anscheck_prompt(task, question, answer, response, abstention=False):
    if not abstention:
        if task in ['single-session-user', 'single-session-assistant', 'multi-session']:
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'temporal-reasoning':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'knowledge-update':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'single-session-preference':
            template = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        else:
            raise NotImplementedError
    else:
        template = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."
        prompt = template.format(question, answer, response)
    return prompt


if __name__ == '__main__':
    argc = len(sys.argv)
    if argc not in (3, 4):
        print('Usage: python longmemeval-judge-groq.py [judge-model] hyp_file ref_file')
        exit()

    if argc == 4:
        metric_model_short = sys.argv[1]
        hyp_file = sys.argv[2]
        ref_file = sys.argv[3]
    else:
        metric_model_short = 'llama-3.3-70b-versatile'
        hyp_file = sys.argv[1]
        ref_file = sys.argv[2]
    verbose = False

    result_file = hyp_file + '.eval-results-{}'.format(metric_model_short)

    if metric_model_short not in model_zoo:
        print('Requested metric model is not supported:', metric_model_short)
        exit()

    metric_model, metric_model_source = model_zoo[metric_model_short]
    if metric_model_source == 'openai':
        openai_api_base = os.getenv('OPENAI_BASE_URL')
    elif metric_model_source == 'groq':
        openai_api_base = 'https://api.groq.com/openai/v1'
    elif metric_model_source == 'gemini':
        openai_api_base = 'https://generativelanguage.googleapis.com/v1beta/openai'
    else:
        openai_api_key = 'EMPTY'
        openai_api_base = 'http://localhost:8001/v1'
    openai_api_key = os.getenv('OPENAI_API_KEY') or os.getenv('GROQ_API_KEY') or os.getenv('GEMINI_API_KEY')

    if not openai_api_key:
        print('No API key found. Set GROQ_API_KEY (or OPENAI_API_KEY).')
        exit()

    metric_client = OpenAI(
        api_key=openai_api_key,
        base_url=openai_api_base,
    )

    try:
        hypotheses = [json.loads(line) for line in open(hyp_file).readlines()]
    except Exception:
        hypotheses = json.load(open(hyp_file))
    try:
        references = json.load(open(ref_file))
    except Exception:
        references = [json.loads(line) for line in open(ref_file).readlines()]
    qid2qdata = {entry['question_id']: entry for entry in references}
    qid2qtype = {entry['question_id']: entry['question_type'] for entry in references}
    qtypes = set(list(qid2qtype.values()))
    qtype2acc = {t: [] for t in qtypes}

    with open(result_file, 'w') as out_f:
        logs = []
        for entry in tqdm(hypotheses):

            if entry['question_id'] not in qid2qtype:
                print('Warning: skipping {} as it is not in reference data.'.format(entry['question_id']))
                continue

            qtype = qid2qtype[entry['question_id']]
            q = qid2qdata[entry['question_id']]['question']
            ans = qid2qdata[entry['question_id']]['answer']
            hyp = entry['hypothesis']

            prompt = get_anscheck_prompt(qtype, q, ans, hyp, abstention='_abs' in entry['question_id'])
            kwargs = {
                'model': metric_model,
                'messages': [
                    {"role": "user", "content": prompt}
                ],
                'n': 1,
                'temperature': 0,
                'max_tokens': 10
            }
            completion = chat_completions_with_backoff(metric_client, **kwargs)
            eval_response = completion.choices[0].message.content.strip()
            label = 'yes' in eval_response.lower()
            entry['autoeval_label'] = {
                'model': metric_model,
                'label': label
            }
            logs.append(entry)
            if verbose:
                print(json.dumps({
                    'question': q,
                    'answer': ans,
                    'hypothesis': hyp,
                    'autoeval_label': label
                }, indent=4), flush=True)
            print(json.dumps(entry), file=out_f)
            qtype2acc[qid2qtype[entry['question_id']]].append(1 if label else 0)

    print('Accuracy:', round(np.mean([1 if x['autoeval_label']['label'] else 0 for x in logs]).item(), 4))
    for k, v in qtype2acc.items():
        print('\t{}: {} ({})'.format(k, round(np.mean(v), 4), len(v)))

    print('Saved to', result_file)
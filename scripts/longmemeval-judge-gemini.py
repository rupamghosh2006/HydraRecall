#!/usr/bin/env python3
"""Gemini Flash judge for HydraRecall LongMemEval outputs.

Uses the official LongMemEval answer-check prompts unchanged, but sends them to
Gemini's OpenAI-compatible endpoint. Results are Gemini-judged, not official
OpenAI-judged scores.
"""

import json
import os
import sys

import backoff
import numpy as np
import openai
from openai import OpenAI
from tqdm import tqdm

@backoff.on_exception(backoff.expo, (openai.RateLimitError, openai.APIError))
def judge_with_backoff(client, **kwargs):
    return client.chat.completions.create(**kwargs)


def read_json_or_jsonl(file_path):
    try:
        return [json.loads(line) for line in open(file_path, encoding="utf-8") if line.strip()]
    except Exception:
        return json.load(open(file_path, encoding="utf-8"))


def answer_check_prompt(task, question, answer, response, abstention=False):
    if abstention:
        return "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.".format(question, answer, response)
    templates = {
        "single-session-user": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
        "single-session-assistant": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
        "multi-session": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
        "temporal-reasoning": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
        "knowledge-update": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
        "single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
    }
    if task not in templates:
        raise NotImplementedError(f"Unsupported LongMemEval task: {task}")
    return templates[task].format(question, answer, response)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: python scripts/longmemeval-judge-gemini.py [gemini-model] hypotheses.jsonl reference.json")
        raise SystemExit(2)

    model = sys.argv[1] if len(sys.argv) == 4 else "gemini-3.5-flash"
    hyp_file = sys.argv[2] if len(sys.argv) == 4 else sys.argv[1]
    ref_file = sys.argv[3] if len(sys.argv) == 4 else sys.argv[2]
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("No Gemini key found. Set GEMINI_API_KEY.")
        raise SystemExit(2)

    client = OpenAI(api_key=api_key, base_url="https://generativelanguage.googleapis.com/v1beta/openai")
    hypotheses = read_json_or_jsonl(hyp_file)
    references = read_json_or_jsonl(ref_file)
    reference_by_id = {entry["question_id"]: entry for entry in references}
    scores_by_type = {}
    labels = []
    result_file = f"{hyp_file}.eval-results-{model}"

    with open(result_file, "w", encoding="utf-8") as out_file:
        for entry in tqdm(hypotheses):
            reference = reference_by_id.get(entry.get("question_id"))
            if not reference:
                continue
            question_type = reference["question_type"]
            prompt = answer_check_prompt(
                question_type,
                reference["question"],
                reference["answer"],
                entry.get("hypothesis", ""),
                abstention="_abs" in entry["question_id"],
            )
            completion = judge_with_backoff(client, model=model, messages=[{"role": "user", "content": prompt}], temperature=0, max_tokens=10)
            correct = "yes" in (completion.choices[0].message.content or "").lower()
            scored = {**entry, "autoeval_label": {"model": model, "judge": "gemini", "label": correct}}
            print(json.dumps(scored), file=out_file)
            labels.append(1 if correct else 0)
            scores_by_type.setdefault(question_type, []).append(1 if correct else 0)

    print("Gemini-judged accuracy:", round(float(np.mean(labels)), 4) if labels else "n/a")
    for question_type, values in sorted(scores_by_type.items()):
        print(f"  {question_type}: {round(float(np.mean(values)), 4)} ({len(values)})")
    print("Saved to", result_file)

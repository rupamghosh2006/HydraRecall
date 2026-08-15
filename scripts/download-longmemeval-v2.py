import os
import urllib.request
import json

def download_file(url, target_path):
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    print(f"Downloading {url} to {target_path}...")
    try:
        urllib.request.urlretrieve(url, target_path)
        print("Done.")
    except Exception as e:
        print(f"Failed to download {url}: {e}")

def main():
    base_url = "https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/resolve/main"
    data_dir = "data/longmemeval-v2"
    
    # We download questions and the small haystack
    download_file(f"{base_url}/questions.jsonl", os.path.join(data_dir, "questions.jsonl"))
    download_file(f"{base_url}/haystacks/lme_v2_small.json", os.path.join(data_dir, "haystacks", "lme_v2_small.json"))
    
    # Trajectories is large and in LFS
    download_file(f"{base_url}/trajectories.jsonl", os.path.join(data_dir, "trajectories.jsonl"))

if __name__ == "__main__":
    main()

import os
import urllib.request
import pandas as pd

def download_file(url, target_path):
    print(f"Downloading {url} to {target_path}...")
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    urllib.request.urlretrieve(url, target_path)
    print("Done.")

def main():
    target_dir = os.path.join("data", "beam")
    parquet_path = os.path.join(target_dir, "100K-00000-of-00001.parquet")
    jsonl_path = os.path.join(target_dir, "conversations-128k.jsonl")
    
    # Download the parquet file from HuggingFace
    parquet_url = "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/100K-00000-of-00001.parquet"
    if not os.path.exists(parquet_path):
        download_file(parquet_url, parquet_path)
    else:
        print(f"File {parquet_path} already exists, skipping download.")
        
    print(f"Converting {parquet_path} to {jsonl_path}...")
    df = pd.read_parquet(parquet_path)
    
    # probing_questions is a stringified python dict, convert it to a real dict
    import ast
    def parse_probe(x):
        try:
            return ast.literal_eval(x)
        except:
            return x
    
    if 'probing_questions' in df.columns:
        df['probing_questions'] = df['probing_questions'].apply(parse_probe)
        
    df.to_json(jsonl_path, orient="records", lines=True)
    print("Done.")

if __name__ == "__main__":
    main()

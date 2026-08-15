import os
with open("lib/longmemeval.mjs", "r", encoding="utf-8") as f:
    content = f.read()
content = content.replace("\\`", "`").replace("\\${", "${").replace("\\n", "\n")
with open("lib/longmemeval.mjs", "w", encoding="utf-8") as f:
    f.write(content)

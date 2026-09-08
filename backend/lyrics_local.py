from __future__ import annotations

from typing import Dict, List


HOMOPHONES: Dict[str, List[str]] = {
    "你": ["拟", "尼", "妮"],
    "我": ["沃"],
    "爱": ["艾", "碍"],
    "的": ["得", "德"],
    "在": ["再"],
    "是": ["事", "试"],
    "不": ["布", "步"],
    "了": ["乐"],
    "和": ["河", "禾"],
    "心": ["新", "欣"],
    "想": ["响", "享"],
    "梦": ["孟"],
    "天": ["添"],
    "夜": ["页"],
    "风": ["枫"],
    "雨": ["语", "羽"],
    "光": ["广"],
    "海": ["亥"],
    "花": ["华"],
    "声": ["生"],
    "歌": ["哥"],
    "见": ["渐"],
    "远": ["院"],
    "吗": ["嘛"],
    "吧": ["巴"],
    "呀": ["压"],
    "啊": ["阿"],
}

PINYIN_FALLBACK: Dict[str, str] = {
    "你": "ni",
    "我": "wo",
    "爱": "ai",
    "的": "de",
    "在": "zai",
    "是": "shi",
    "不": "bu",
    "了": "le",
    "和": "he",
    "心": "xin",
    "想": "xiang",
    "梦": "meng",
    "天": "tian",
    "夜": "ye",
    "风": "feng",
    "雨": "yu",
    "光": "guang",
    "海": "hai",
    "花": "hua",
    "声": "sheng",
    "歌": "ge",
    "见": "jian",
    "远": "yuan",
    "吗": "ma",
    "吧": "ba",
    "呀": "ya",
    "啊": "a",
}


def to_pinyin(text: str) -> str:
    try:
      from pypinyin import lazy_pinyin  # type: ignore
    except Exception:
      lines: List[str] = []
      for line in text.splitlines():
          lines.append(" ".join(PINYIN_FALLBACK.get(ch, ch) for ch in line))
      return "\n".join(lines)

    out: List[str] = []
    for line in text.splitlines():
        parts = lazy_pinyin(line, errors=lambda chars: list(chars))
        out.append(" ".join(parts))
    return "\n".join(out)


def homophone_replace(text: str) -> str:
    counters: Dict[str, int] = {}
    output: List[str] = []
    for ch in text:
        choices = HOMOPHONES.get(ch)
        if not choices:
            output.append(ch)
            continue
        idx = counters.get(ch, 0)
        counters[ch] = idx + 1
        output.append(choices[idx % len(choices)])
    return "".join(output)


def process(mode: str, text: str) -> str:
    if mode == "pinyin":
        return to_pinyin(text)
    if mode == "homophone":
        return homophone_replace(text)
    raise ValueError(f"unknown lyrics mode: {mode}")

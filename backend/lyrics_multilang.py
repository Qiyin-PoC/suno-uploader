"""多语言歌词本地处理引擎（期音科技）

第一版：全离线本地规则。
支持：中文同音替换、中文转拼音、粤语转粤拼、英语发音改写、韩语转罗马音、泰语转罗马音。
"""
from __future__ import annotations
import re
from typing import Dict, List

# ── 粤语常用词表 ──
CANTONESE_MAP: Dict[str, str] = {
    "我哋": "ngo dei", "你哋": "nei dei", "佢哋": "keoi dei",
    "今晚": "gam maan", "聽日": "ting jat", "尋日": "cam jat",
    "邊度": "bin dou", "呢度": "ni dou", "嗰度": "go dou",
    "乜嘢": "mat je", "點解": "dim gaai", "點樣": "dim joeng",
    "唔該": "m goi", "多謝": "do ze", "對唔住": "deoi m zyu",
    "係": "hai", "唔係": "m hai", "冇": "mou",
    "食": "sik", "飲": "jam", "去": "heoi", "返": "faan",
    "好": "hou", "大": "daai", "細": "sai", "多": "do",
    "愛": "oi", "想": "soeng", "知": "zi", "見": "gin",
    "人": "jan", "心": "sam", "天": "tin", "地": "dei",
    "講": "gong", "聽": "teng", "睇": "tai", "打": "daa",
    "做": "zou", "住": "zyu", "落": "lok", "上": "soeng",
    "水": "seoi", "火": "fo", "風": "fung", "花": "faa",
    "男": "naam", "女": "neoi", "仔": "zai", "女": "neoi",
    "屋": "uk", "門": "mun", "車": "ce", "路": "lou",
    "新": "san", "舊": "gau", "快": "faai", "慢": "maan",
    "嚟": "lai", "走": "zau", "坐": "co", "企": "kei",
}

# ── 英语发音改写表 ──
ENG_PRONUNCIATION: Dict[str, str] = {
    "love": "luv", "you": "ya", "your": "yor",
    "night": "nite", "tonight": "tanite", "light": "lite",
    "right": "rite", "fight": "fite", "through": "thru",
    "though": "tho", "want to": "wanna", "going to": "gonna",
    "got to": "gotta", "kind of": "kinda", "out of": "outta",
    "don't": "dont", "can't": "cant", "won't": "wont",
    "isn't": "isnt", "ain't": "aint", "it's": "its",
    "baby": "baybee", "heart": "hart", "dream": "dreem",
    "feel": "feel", "real": "reel", "forever": "foreva",
    "together": "togetha", "never": "neva", "ever": "eva",
    "remember": "rememba", "better": "betta",
    "dance": "dans", "chance": "chans", "face": "fase",
    "here": "heer", "there": "ther", "where": "wher",
    "come": "cum", "some": "sum", "done": "dun",
    "just": "jus", "must": "mus", "trust": "trus",
    "good": "gud", "should": "shud", "would": "wud",
}

# ── 韩语字形映射 ──
KOREAN_JAMO: Dict[str, str] = {
    "ㄱ": "g", "ㄲ": "kk", "ㄴ": "n", "ㄷ": "d", "ㄸ": "tt",
    "ㄹ": "r", "ㅁ": "m", "ㅂ": "b", "ㅃ": "pp", "ㅅ": "s",
    "ㅆ": "ss", "ㅇ": "", "ㅈ": "j", "ㅉ": "jj", "ㅊ": "ch",
    "ㅋ": "k", "ㅌ": "t", "ㅍ": "p", "ㅎ": "h",
    "ㅏ": "a", "ㅐ": "ae", "ㅑ": "ya", "ㅒ": "yae",
    "ㅓ": "eo", "ㅔ": "e", "ㅕ": "yeo", "ㅖ": "ye",
    "ㅗ": "o", "ㅘ": "wa", "ㅙ": "wae", "ㅚ": "oe",
    "ㅛ": "yo", "ㅜ": "u", "ㅝ": "wo", "ㅞ": "we",
    "ㅟ": "wi", "ㅠ": "yu", "ㅡ": "eu", "ㅢ": "ui",
    "ㅣ": "i",
    "ㄳ": "gs", "ㄵ": "nj", "ㄶ": "nh", "ㄺ": "lg",
    "ㄻ": "lm", "ㄼ": "lb", "ㄽ": "ls", "ㄾ": "lt",
    "ㄿ": "lp", "ㅀ": "lh", "ㅄ": "bs",
}

# ── 泰语常见词表 ──
THAI_COMMON: Dict[str, str] = {
    "รัก": "rak", "เธอ": "ter", "ฉัน": "chan", "คุณ": "khun",
    "มาก": "mak", "ใจ": "jai", "คน": "khon", "ไป": "bpai",
    "มา": "maa", "ได้": "dai", "ไม่": "mai", "มี": "mee",
    "ทำ": "tam", "พูด": "phut", "กิน": "gin", "นอน": "nawn",
    "เพราะ": "phraw", "หรือ": "reu", "และ": "lae", "ใน": "nai",
    "บอก": "bawk", "ขอ": "khaw", "ให้": "hai", "รับ": "rap",
    "วัน": "wan", "คืน": "khuen", "ฟ้า": "faa", "น้ำ": "nam",
    "เสีย": "sia", "เจอ": "jer", "รอ": "raw", "กลัว": "klua",
    "ดี": "dee", "เลว": "leow", "เล็ก": "lek", "ใหญ่": "yai",
    "ช้า": "cha", "เร็ว": "reow", "ร้อน": "rawn", "หนาว": "naow",
    "สวย": "suay", "งาม": "ngaam", "ง่าย": "ngaai", "ยาก": "yaak",
}


def process_cantonese(text: str) -> str:
    """粤语 → 粤拼。"""
    result: List[str] = []
    i = 0
    while i < len(text):
        matched = False
        for length in (4, 3, 2, 1):
            key = text[i:i + length]
            if key in CANTONESE_MAP:
                result.append(CANTONESE_MAP[key])
                i += length
                matched = True
                break
        if not matched:
            ch = text[i]
            if re.match(r"[\u4e00-\u9fff]", ch):
                result.append(ch)
            else:
                result.append(ch)
            i += 1
    return " ".join(result)


def process_english_pronunciation(text: str) -> str:
    """英语 → 发音近似改写。"""
    pattern = r"(?<![A-Za-z])(?:" + "|".join(
        re.escape(key) for key in sorted(ENG_PRONUNCIATION, key=len, reverse=True)
    ) + r")(?![A-Za-z])"
    return re.sub(pattern, lambda match: ENG_PRONUNCIATION[match.group().lower()],
                  text, flags=re.IGNORECASE)


def _kr_decompose(ch: str) -> List[str]:
    """拆解 Hangul 到 Jamo。"""
    code = ord(ch)
    if 0xAC00 <= code <= 0xD7A3:
        offset = code - 0xAC00
        cho = offset // (21 * 28)
        jung = (offset % (21 * 28)) // 28
        jong = offset % 28
        parts = [chr(0x1100 + cho), chr(0x1161 + jung)]
        if jong:
            parts.append(chr(0x11A7 + jong))
        return parts
    return [ch]


def process_korean_romanization(text: str) -> str:
    """韩语 → 罗马音。"""
    # Initials, vowels and finals use different positional pronunciations.
    initials = ("g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h")
    vowels = ("a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i")
    finals = ("", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t")
    result: List[str] = []
    for ch in text:
        if "가" <= ch <= "힣":
            offset = ord(ch) - 0xAC00
            result.append(initials[offset // 588] + vowels[(offset % 588) // 28] + finals[offset % 28])
        else:
            result.append(KOREAN_JAMO.get(ch, ch))
    return "".join(result)


def process_thai_romanization(text: str) -> str:
    """泰语 → 罗马音。"""
    result: List[str] = []
    i = 0
    while i < len(text):
        matched = False
        for length in (5, 4, 3, 2, 1):
            key = text[i:i + length]
            if key in THAI_COMMON:
                result.append(THAI_COMMON[key])
                i += length
                matched = True
                break
        if not matched:
            ch = text[i]
            if "\u0E00" <= ch <= "\u0E7F":
                result.append(ch)
            else:
                result.append(ch)
            i += 1
    return " ".join(result)


def process_multilang(text: str, mode: str) -> str:
    """多语言歌词处理入口。"""
    modes = {
        "cantonese":     process_cantonese,
        "english-pron":  process_english_pronunciation,
        "korean-roman":  process_korean_romanization,
        "thai-roman":    process_thai_romanization,
    }
    fn = modes.get(mode)
    if fn:
        return fn(text)
    raise ValueError(f"未知歌词处理模式：{mode}")

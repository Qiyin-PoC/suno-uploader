import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from lyrics_multilang import process_multilang

def test_korean_syllables_become_latin_and_keep_spacing():
    assert process_multilang('사랑해 한국!', 'korean-roman') == 'saranghae hanguk!'

def test_english_rewrites_words_without_corrupting_longer_words():
    assert process_multilang('I love you tonight', 'english-pron') == 'I luv ya tanite'
    assert process_multilang('somebody highlight dance', 'english-pron') == 'somebody highlight dans'

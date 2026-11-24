// AI video editing (ai.video-editing): the closed library of commentary phrases (spec section 13). The model only
// picks an id of this list; the text comes from here, in the video's language. A language without a phrase
// falls back to keyword echo. Mood tags are the ones perception answers with.
import { Phrase } from './edit.contract';

// A phrase with its mood tags and its English and Bengali text.
const phrase = (id: string, mood: string[], en: string, bn: string): Phrase => ({
  id,
  mood,
  text: { en, bn },
});

export const PHRASES: Phrase[] = [
  phrase('did_you_know', ['surprising'], 'Did you know?', 'জানেন কি?'),
  phrase('wait', ['surprising'], 'Wait…', 'দাঁড়ান…'),
  phrase('interesting', ['calm', 'surprising'], 'Interesting', 'মজার ব্যাপার'),
  phrase('so_sad', ['sad'], 'So sad', 'কী দুঃখের'),
  phrase('attention', ['serious'], 'Attention', 'মনোযোগ দিন'),
  phrase('facts', ['serious', 'calm'], 'Facts', 'সত্যি কথা'),
  phrase('big_mistake', ['serious'], 'Big mistake', 'বড় ভুল'),
  phrase('listen_up', ['serious', 'excited'], 'Listen up', 'শুনুন'),
  phrase('mind_blown', ['surprising', 'excited'], 'Mind blown', 'মাথা ঘুরে গেল'),
  phrase('game_changer', ['excited'], 'Game changer', 'গেম চেঞ্জার'),
  phrase('pro_tip', ['calm', 'serious'], 'Pro tip', 'সেরা টিপ'),
  phrase('remember_this', ['serious'], 'Remember this', 'মনে রাখুন'),
  phrase('important', ['serious'], 'Important', 'গুরুত্বপূর্ণ'),
  phrase('true_story', ['calm'], 'True story', 'সত্যি ঘটনা'),
  phrase('no_way', ['surprising'], 'No way!', 'অসম্ভব!'),
  phrase('seriously', ['surprising', 'funny'], 'Seriously?', 'সত্যিই?'),
  phrase('heads_up', ['serious'], 'Heads up', 'সাবধান'),
  phrase('warning', ['serious'], 'Warning', 'সতর্কতা'),
  phrase('big_win', ['excited'], 'Big win', 'বড় জয়'),
  phrase('love_it', ['excited'], 'Love it', 'দারুণ'),
  phrase('amazing', ['excited'], 'Amazing', 'অসাধারণ'),
  phrase('so_true', ['calm'], 'So true', 'একদম ঠিক'),
  phrase('oops', ['funny'], 'Oops', 'ইশ'),
  phrase('haha', ['funny'], 'Haha', 'হাহা'),
  phrase('not_good', ['sad'], 'Not good', 'ভালো না'),
  phrase('painful', ['sad'], 'Painful', 'কষ্টের'),
  phrase('sad_truth', ['sad'], 'Sad truth', 'দুঃখের সত্য'),
  phrase('here_is_why', ['calm', 'serious'], 'Here is why', 'কারণটা হলো'),
  phrase('the_secret', ['surprising'], 'The secret', 'আসল রহস্য'),
  phrase('stop_scrolling', ['excited'], 'Stop scrolling', 'থামুন'),
  phrase('think_about_it', ['calm'], 'Think about it', 'একটু ভাবুন'),
  phrase('let_that_sink_in', ['serious', 'sad'], 'Let that sink in', 'ভেবে দেখুন'),
  phrase('the_truth', ['serious'], 'The truth', 'আসল সত্য'),
  phrase('real_talk', ['serious', 'calm'], 'Real talk', 'সোজা কথা'),
  phrase('plot_twist', ['surprising', 'funny'], 'Plot twist', 'নতুন মোড়'),
  phrase('huge', ['excited', 'surprising'], 'Huge', 'বিশাল'),
  phrase('so_easy', ['calm', 'excited'], 'So easy', 'খুব সহজ'),
  phrase('quick_tip', ['calm'], 'Quick tip', 'ছোট্ট টিপ'),
  phrase('be_careful', ['serious'], 'Be careful', 'সাবধানে'),
  phrase('you_got_this', ['excited', 'calm'], 'You got this', 'আপনি পারবেন'),
];

// One phrase by id, or undefined.
export const phraseById = (id: string) =>
  PHRASES.find((entry) => entry.id === id);

// The phrases that carry a mood tag.
export const phrasesForMood = (mood: string) =>
  PHRASES.filter((entry) => entry.mood.includes(mood));

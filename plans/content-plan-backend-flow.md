# "Create Video Plan": backend flow, real run

Real API calls made on 2026-11-23 with a fictional business (Smile Dental Clinic, Dhaka). Every input and output below is copied from the saved responses, not written by hand. Raw request/response files: `/tmp/claude-1000/-home-haku-projects-Next-js-Social-Media-Manager/ee6b0f7a-25f2-47bf-88da-ce2a7c752602/scratchpad/flow-run/`.

Nothing here is main code. The prototype is one throwaway script. Database saving is described, not run.

## Overview

| # | Who | What | Model / effort |
|---|---|---|---|
| 0 | Code | Click "Create Video Plan": receive the text and read `videosPerWeek` from the database | none |
| 1 | LLM | Refine the raw text into the Content Direction and facts | muse-spark-1.3-contributor, low |
| 2 | LLM | Themes and clusters (customer problems) from the refined direction | same, medium |
| 3 | Code | Interleave clusters, assign 12 weeks with dates | none |
| 4 | LLM | One core idea per week, 12 items | same, medium |
| 5 | Code | Save the plan (described only) | none |
| 6 | Code | Week 1: read N, pick angles and video days | none |
| 7 | LLM | Write week 1: brief plus N videos | same, medium |
| 8 | Code | Map answers to days, build the JSON the phone reads | none |

Total for this run: 4 LLM calls, 12296 tokens (prompt + completion).

## Step 0. Click (code)

**Input** (what the web form sends, plus the database value):
```json
{
  "businessInfo": "We run Smile Dental Clinic in Dhaka (Dhanmondi). General dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\nOur patients are mostly working adults 25-45 and parents of young children. Many delay visits because they fear pain and think treatment is\nvery expensive. Some believe a root canal means losing the tooth. We want friendly, calm, honest videos in Bangla-English mix. Videos about 60 seconds.",
  "videosPerWeek": 3
}
```

**Output:** the job starts and the page shows "Thinking…".

## Step 1. Refine (LLM)
**Model:** `muse-spark-1.3-contributor`, reasoning effort `low`, structured JSON output (strict schema)

**Frame (developer message 1):**
> You are a content strategist. Rewrite the owner's raw text as a clear Content Direction (short paragraphs: what the business does, for whom, customers' core problems, how it solves them, common objections or misunderstandings, tone). Keep everything the owner wrote. Also fill facts from it; videoSeconds is one of 30, 60, 90, 120.

**Rules (developer message 2, same for every call):**
> Return only the JSON asked for. Write in the language the owner used. Never invent prices, dates, offers, statistics, customer names, quotes or news the owner did not give. Ideas must serve the owner's customers' real problems. No generic filler.

**Input (user message):**
```json
{
  "businessInfo": "We run Smile Dental Clinic in Dhaka (Dhanmondi). General dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\nOur patients are mostly working adults 25-45 and parents of young children. Many delay visits because they fear pain and think treatment is\nvery expensive. Some believe a root canal means losing the tooth. We want friendly, calm, honest videos in Bangla-English mix. Videos about 60 seconds."
}
```

**Output:**
```json
{
  "direction": "Smile Dental Clinic in Dhaka (Dhanmondi) provides general dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\n\nIt serves mostly working adults 25-45 and parents of young children.\n\nMany customers delay visits because they fear pain and think treatment is very expensive.\n\nThe clinic addresses this with friendly, calm, honest care across its general dentistry services for adults and kids.\n\nCommon misunderstandings to address: that treatment is very expensive, and that a root canal means losing the tooth.\n\nTone for videos is friendly, calm, honest in Bangla-English mix, about 60 seconds.",
  "facts": {
    "audience": "working adults 25-45 and parents of young children",
    "objections": [
      "think treatment is very expensive",
      "believe a root canal means losing the tooth"
    ],
    "problems": [
      "fear pain",
      "think treatment is very expensive",
      "delay visits"
    ],
    "solution": "General dentistry: checkups, cleaning, root canal, braces, kids' dentistry with friendly, calm, honest care",
    "tone": "friendly, calm, honest in Bangla-English mix",
    "videoSeconds": 60,
    "whatWeDo": "We run Smile Dental Clinic in Dhaka (Dhanmondi). General dentistry: checkups, cleaning, root canal, braces, kids' dentistry."
  }
}
```

**Tokens:** prompt 380, completion 1072 (reasoning 768), cached 0

**Observed:** the direction is mostly a tidy restatement of the raw text, with no new information. No questions were asked in this prototype.

## Step 2. Themes and clusters (LLM)
Input is the **refined** direction and facts only, never the raw text.
**Model:** `muse-spark-1.3-contributor`, reasoning effort `medium`, structured JSON output (strict schema)

**Frame (developer message 1):**
> From the Content Direction, produce 3 themes. Each theme has 3 clusters. A cluster is one specific customer problem or question, in the customers' words.

**Rules (developer message 2, same for every call):**
> Return only the JSON asked for. Write in the language the owner used. Never invent prices, dates, offers, statistics, customer names, quotes or news the owner did not give. Ideas must serve the owner's customers' real problems. No generic filler.

**Input (user message):**
```json
{
  "direction": "Smile Dental Clinic in Dhaka (Dhanmondi) provides general dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\n\nIt serves mostly working adults 25-45 and parents of young children.\n\nMany customers delay visits because they fear pain and think treatment is very expensive.\n\nThe clinic addresses this with friendly, calm, honest care across its general dentistry services for adults and kids.\n\nCommon misunderstandings to address: that treatment is very expensive, and that a root canal means losing the tooth.\n\nTone for videos is friendly, calm, honest in Bangla-English mix, about 60 seconds.",
  "facts": {
    "audience": "working adults 25-45 and parents of young children",
    "objections": [
      "think treatment is very expensive",
      "believe a root canal means losing the tooth"
    ],
    "problems": [
      "fear pain",
      "think treatment is very expensive",
      "delay visits"
    ],
    "solution": "General dentistry: checkups, cleaning, root canal, braces, kids' dentistry with friendly, calm, honest care",
    "tone": "friendly, calm, honest in Bangla-English mix",
    "videoSeconds": 60,
    "whatWeDo": "We run Smile Dental Clinic in Dhaka (Dhanmondi). General dentistry: checkups, cleaning, root canal, braces, kids' dentistry."
  }
}
```

**Output:**
```json
{
  "themes": [
    {
      "clusters": [
        {
          "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?",
          "title": "Will teeth cleaning and checkup hurt?"
        },
        {
          "problem": "I have mild pain and sensitivity now but I'm scared to go - what if I just wait until I can't bear it anymore?",
          "title": "Should I wait till my tooth pain gets really bad?"
        },
        {
          "problem": "I am busy with office all week and I keep delaying - will a routine checkup take long and be stressful?",
          "title": "How do I manage a dental visit with my busy job?"
        }
      ],
      "description": "For working adults 25-45 in Dhanmondi who delay checkups and cleaning because they fear pain, showing calm friendly care.",
      "name": "I Keep Delaying Because I'm Scared It Will Hurt"
    },
    {
      "clusters": [
        {
          "problem": "I think cleaning or cavity treatment will cost too much so I avoid going - is dental treatment really that expensive?",
          "title": "Is dental cleaning and treatment very expensive?"
        },
        {
          "problem": "I'm afraid if I go they will say I need lots of expensive treatment - will I get honest advice only for what I need?",
          "title": "Will the dentist suggest treatment I don't really need?"
        },
        {
          "problem": "I delay visits to save money - will waiting make my problem bigger and treatment more difficult later?",
          "title": "Is it better to go early or wait to save money?"
        }
      ],
      "description": "For working adults who think treatment is very expensive, explaining honest guidance on checkups, cleaning and early care.",
      "name": "I Think Dental Treatment Is Too Expensive"
    },
    {
      "clusters": [
        {
          "problem": "Doctor said I may need root canal - does root canal mean my tooth is gone and I will lose it?",
          "title": "Does root canal mean I will lose my tooth?"
        },
        {
          "problem": "I am 25-45 and thinking about braces but scared of pain and hassle with work life - is it manageable?",
          "title": "Are braces painful and difficult for working adults?"
        },
        {
          "problem": "My kid cries and is scared of the dentist - will kids checkup and treatment be calm and friendly for them?",
          "title": "My child is scared of the dentist, what to do?"
        }
      ],
      "description": "For adults worried about root canal and braces, and parents worried about kids dentistry pain and fear.",
      "name": "Root Canal, Braces and My Kid's Teeth Worries"
    }
  ]
}
```

**Tokens:** prompt 488, completion 1994 (reasoning 1463), cached 0

**Observed:** 3 themes × 3 clusters = 9 clusters for 12 weeks, so weeks 10–12 reuse the clusters of weeks 1–3.

## Step 3. Assign 12 weeks (code)
**Input:** step 2's themes and clusters, today's date (2026-11-23).

**Rule:** interleave the clusters across themes (theme 1 cluster 1, theme 2 cluster 1, theme 3 cluster 1, theme 1 cluster 2, …), cycle when they run out, then give the weeks dates 7 days apart.

**Output:**
```json
[
  {
    "week": 1,
    "weekStart": "2026-11-23",
    "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
    "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?",
    "title": "Will teeth cleaning and checkup hurt?"
  },
  {
    "week": 2,
    "weekStart": "2026-11-30",
    "theme": "I Think Dental Treatment Is Too Expensive",
    "problem": "I think cleaning or cavity treatment will cost too much so I avoid going - is dental treatment really that expensive?",
    "title": "Is dental cleaning and treatment very expensive?"
  },
  {
    "week": 3,
    "weekStart": "2026-12-07",
    "theme": "Root Canal, Braces and My Kid's Teeth Worries",
    "problem": "Doctor said I may need root canal - does root canal mean my tooth is gone and I will lose it?",
    "title": "Does root canal mean I will lose my tooth?"
  },
  {
    "week": 4,
    "weekStart": "2026-12-14",
    "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
    "problem": "I have mild pain and sensitivity now but I'm scared to go - what if I just wait until I can't bear it anymore?",
    "title": "Should I wait till my tooth pain gets really bad?"
  },
  {
    "week": 5,
    "weekStart": "2026-12-21",
    "theme": "I Think Dental Treatment Is Too Expensive",
    "problem": "I'm afraid if I go they will say I need lots of expensive treatment - will I get honest advice only for what I need?",
    "title": "Will the dentist suggest treatment I don't really need?"
  },
  {
    "week": 6,
    "weekStart": "2026-12-28",
    "theme": "Root Canal, Braces and My Kid's Teeth Worries",
    "problem": "I am 25-45 and thinking about braces but scared of pain and hassle with work life - is it manageable?",
    "title": "Are braces painful and difficult for working adults?"
  },
  {
    "week": 7,
    "weekStart": "2027-01-04",
    "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
    "problem": "I am busy with office all week and I keep delaying - will a routine checkup take long and be stressful?",
    "title": "How do I manage a dental visit with my busy job?"
  },
  {
    "week": 8,
    "weekStart": "2027-01-11",
    "theme": "I Think Dental Treatment Is Too Expensive",
    "problem": "I delay visits to save money - will waiting make my problem bigger and treatment more difficult later?",
    "title": "Is it better to go early or wait to save money?"
  },
  {
    "week": 9,
    "weekStart": "2027-01-18",
    "theme": "Root Canal, Braces and My Kid's Teeth Worries",
    "problem": "My kid cries and is scared of the dentist - will kids checkup and treatment be calm and friendly for them?",
    "title": "My child is scared of the dentist, what to do?"
  },
  {
    "week": 10,
    "weekStart": "2027-01-25",
    "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
    "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?",
    "title": "Will teeth cleaning and checkup hurt?"
  },
  {
    "week": 11,
    "weekStart": "2027-02-01",
    "theme": "I Think Dental Treatment Is Too Expensive",
    "problem": "I think cleaning or cavity treatment will cost too much so I avoid going - is dental treatment really that expensive?",
    "title": "Is dental cleaning and treatment very expensive?"
  },
  {
    "week": 12,
    "weekStart": "2027-02-08",
    "theme": "Root Canal, Braces and My Kid's Teeth Worries",
    "problem": "Doctor said I may need root canal - does root canal mean my tooth is gone and I will lose it?",
    "title": "Does root canal mean I will lose my tooth?"
  }
]
```

## Step 4. Core ideas (LLM)
Input is the refined direction plus step 3's weeks. Note: there is no `videosPerWeek` here.
**Model:** `muse-spark-1.3-contributor`, reasoning effort `medium`, structured JSON output (strict schema)

**Frame (developer message 1):**
> For each given week write one specific core idea (one sentence, at most 300 characters) for a short video week, about the given cluster problem. Each idea must be new compared with the other weeks of the same cluster. Return one item per week, same week numbers.

**Rules (developer message 2, same for every call):**
> Return only the JSON asked for. Write in the language the owner used. Never invent prices, dates, offers, statistics, customer names, quotes or news the owner did not give. Ideas must serve the owner's customers' real problems. No generic filler.

**Input (user message):**
```json
{
  "direction": "Smile Dental Clinic in Dhaka (Dhanmondi) provides general dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\n\nIt serves mostly working adults 25-45 and parents of young children.\n\nMany customers delay visits because they fear pain and think treatment is very expensive.\n\nThe clinic addresses this with friendly, calm, honest care across its general dentistry services for adults and kids.\n\nCommon misunderstandings to address: that treatment is very expensive, and that a root canal means losing the tooth.\n\nTone for videos is friendly, calm, honest in Bangla-English mix, about 60 seconds.",
  "weeks": [
    {
      "week": 1,
      "weekStart": "2026-11-23",
      "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
      "cluster": "Will teeth cleaning and checkup hurt?",
      "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?"
    },
    {
      "week": 2,
      "weekStart": "2026-11-30",
      "theme": "I Think Dental Treatment Is Too Expensive",
      "cluster": "Is dental cleaning and treatment very expensive?",
      "problem": "I think cleaning or cavity treatment will cost too much so I avoid going - is dental treatment really that expensive?"
    },
    {
      "week": 3,
      "weekStart": "2026-12-07",
      "theme": "Root Canal, Braces and My Kid's Teeth Worries",
      "cluster": "Does root canal mean I will lose my tooth?",
      "problem": "Doctor said I may need root canal - does root canal mean my tooth is gone and I will lose it?"
    },
    {
      "week": 4,
      "weekStart": "2026-12-14",
      "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
      "cluster": "Should I wait till my tooth pain gets really bad?",
      "problem": "I have mild pain and sensitivity now but I'm scared to go - what if I just wait until I can't bear it anymore?"
    },
    {
      "week": 5,
      "weekStart": "2026-12-21",
      "theme": "I Think Dental Treatment Is Too Expensive",
      "cluster": "Will the dentist suggest treatment I don't really need?",
      "problem": "I'm afraid if I go they will say I need lots of expensive treatment - will I get honest advice only for what I need?"
    },
    {
      "week": 6,
      "weekStart": "2026-12-28",
      "theme": "Root Canal, Braces and My Kid's Teeth Worries",
      "cluster": "Are braces painful and difficult for working adults?",
      "problem": "I am 25-45 and thinking about braces but scared of pain and hassle with work life - is it manageable?"
    },
    {
      "week": 7,
      "weekStart": "2027-01-04",
      "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
      "cluster": "How do I manage a dental visit with my busy job?",
      "problem": "I am busy with office all week and I keep delaying - will a routine checkup take long and be stressful?"
    },
    {
      "week": 8,
      "weekStart": "2027-01-11",
      "theme": "I Think Dental Treatment Is Too Expensive",
      "cluster": "Is it better to go early or wait to save money?",
      "problem": "I delay visits to save money - will waiting make my problem bigger and treatment more difficult later?"
    },
    {
      "week": 9,
      "weekStart": "2027-01-18",
      "theme": "Root Canal, Braces and My Kid's Teeth Worries",
      "cluster": "My child is scared of the dentist, what to do?",
      "problem": "My kid cries and is scared of the dentist - will kids checkup and treatment be calm and friendly for them?"
    },
    {
      "week": 10,
      "weekStart": "2027-01-25",
      "theme": "I Keep Delaying Because I'm Scared It Will Hurt",
      "cluster": "Will teeth cleaning and checkup hurt?",
      "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?"
    },
    {
      "week": 11,
      "weekStart": "2027-02-01",
      "theme": "I Think Dental Treatment Is Too Expensive",
      "cluster": "Is dental cleaning and treatment very expensive?",
      "problem": "I think cleaning or cavity treatment will cost too much so I avoid going - is dental treatment really that expensive?"
    },
    {
      "week": 12,
      "weekStart": "2027-02-08",
      "theme": "Root Canal, Braces and My Kid's Teeth Worries",
      "cluster": "Does root canal mean I will lose my tooth?",
      "problem": "Doctor said I may need root canal - does root canal mean my tooth is gone and I will lose it?"
    }
  ]
}
```

**Output:**
```json
{
  "ideas": [
    {
      "idea": "Show exactly what a gentle checkup and ultrasonic cleaning feels like after years of gap — mostly vibration and pressure, with calm pauses and explanation throughout.",
      "week": 1
    },
    {
      "idea": "Explain how a routine checkup gives a clear honest plan first so you know what cleaning or small cavity care involves before deciding, easing fear of huge cost.",
      "week": 2
    },
    {
      "idea": "Explain in simple terms that root canal cleans infection inside to save your natural tooth, not remove it, so you can keep chewing with it.",
      "week": 3
    },
    {
      "idea": "Show why mild sensitivity should not wait till unbearable pain, because early check finds the cause while care is simpler and calmer.",
      "week": 4
    },
    {
      "idea": "Show how the dentist checks, shows you the problem clearly, and suggests only what is truly needed with honest options and no pressure.",
      "week": 5
    },
    {
      "idea": "Follow a working adult through braces life with office talks, eating and cleaning, showing initial tightness is manageable with calm guidance.",
      "week": 6
    },
    {
      "idea": "Show how a busy office worker fits a short calm routine checkup in Dhanmondi without long waiting or stress, from entry to exit.",
      "week": 7
    },
    {
      "idea": "Compare an early small cavity visit versus waiting months, showing waiting usually makes treatment longer and more uncomfortable, not cheaper.",
      "week": 8
    },
    {
      "idea": "Show a scared childs first calm visit with friendly talk, chair ride and teeth counting, so parents see kids dentistry feels safe not scary.",
      "week": 9
    },
    {
      "idea": "Reassure those who delayed cleaning for years that the first visit is just gentle checking and slow step-by-step cleaning with breaks if you feel uneasy.",
      "week": 10
    },
    {
      "idea": "Show how asking openly about treatment options at the Dhanmondi clinic gets calm honest answers, so you never feel pushed into expensive care.",
      "week": 11
    },
    {
      "idea": "Show a saved tooth after root canal with proper cap chewing normally, proving treatment means keeping your tooth, not losing it.",
      "week": 12
    }
  ]
}
```

**Tokens:** prompt 1131, completion 2134 (reasoning 1672), cached 0

**Observed:** all 12 ideas are different from each other, including the ones that share a cluster (weeks 1/10, 2/11, 3/12).

## Step 5. Save the plan (code, described only)
Would store: 1 `ContentPlan` row (direction, facts, `videosPerWeek = 3`), 3 `PlanTheme`, 9 `PlanCluster`, 12 `PlanWeek` (week start, cluster, idea, status `IDEA`). No video days yet.

In the real system, steps 6–8 run for week 1 right after confirm, and for each later week at its start. Here they run straight after for week 1.

## Step 6. Week 1 slots (code)
**Input:** `videosPerWeek = 3` (from the database), week 1 start `2026-11-23`.

**Rule:** video days come from the fixed table (3 videos → day offsets 0, 2, 4). Angles are the first 3 of the angle list in this prototype (the real rule also avoids recently used angles).

**Output:**
```json
[
  {
    "slot": 1,
    "dayIndex": 0,
    "date": "2026-11-23",
    "angle": "problem"
  },
  {
    "slot": 2,
    "dayIndex": 2,
    "date": "2026-11-25",
    "angle": "mistake"
  },
  {
    "slot": 3,
    "dayIndex": 4,
    "date": "2026-11-27",
    "angle": "story"
  }
]
```

## Step 7. Week 1 videos (LLM)
Input: refined direction, week 1's idea, cluster and problem, N, video length, beat count (from `videoSeconds` 60 → 4 beats), and step 6's slots.
**Model:** `muse-spark-1.3-contributor`, reasoning effort `medium`, structured JSON output (strict schema)

**Frame (developer message 1):**
> Write the week's brief (2-4 plain sentences), then exactly one video per given slot, in slot order, following each slot's angle. Per video: title (under 8 words), why (one line tying it to the owner's customers), beats (exactly beatsCount items, each {hook, say}: hook = on-screen cue of 2-8 words, plain text; say = 1-3 short spoken sentences; all says together last about videoSeconds; beat 1 says opens with a line that grabs attention in 3 seconds), closingLine (one natural, not salesy call to action). With one video it carries the whole idea; with a few each stands alone; with many they build on each other.

**Rules (developer message 2, same for every call):**
> Return only the JSON asked for. Write in the language the owner used. Never invent prices, dates, offers, statistics, customer names, quotes or news the owner did not give. Ideas must serve the owner's customers' real problems. No generic filler.

**Input (user message):**
```json
{
  "direction": "Smile Dental Clinic in Dhaka (Dhanmondi) provides general dentistry: checkups, cleaning, root canal, braces, kids' dentistry.\n\nIt serves mostly working adults 25-45 and parents of young children.\n\nMany customers delay visits because they fear pain and think treatment is very expensive.\n\nThe clinic addresses this with friendly, calm, honest care across its general dentistry services for adults and kids.\n\nCommon misunderstandings to address: that treatment is very expensive, and that a root canal means losing the tooth.\n\nTone for videos is friendly, calm, honest in Bangla-English mix, about 60 seconds.",
  "idea": "Show exactly what a gentle checkup and ultrasonic cleaning feels like after years of gap — mostly vibration and pressure, with calm pauses and explanation throughout.",
  "cluster": "Will teeth cleaning and checkup hurt?",
  "problem": "I haven't done cleaning in years because I'm scared it will be painful - is checkup and cleaning really painful?",
  "videosPerWeek": 3,
  "videoSeconds": 60,
  "beatsCount": 4,
  "slots": [
    {
      "slot": 1,
      "dayIndex": 0,
      "date": "2026-11-23",
      "angle": "problem"
    },
    {
      "slot": 2,
      "dayIndex": 2,
      "date": "2026-11-25",
      "angle": "mistake"
    },
    {
      "slot": 3,
      "dayIndex": 4,
      "date": "2026-11-27",
      "angle": "story"
    }
  ]
}
```

**Output:**
```json
{
  "brief": "Many working adults in Dhanmondi avoid checkup and cleaning for years because they expect pain. This week we show step-by-step what a gentle checkup and ultrasonic cleaning actually feels like. Calm, honest, no fear - just vibration, pressure and clear explanation.",
  "videos": [
    {
      "beats": [
        {
          "hook": "Years Since Last Cleaning?",
          "say": "Bochorer por bochor cleaning koren ni, karon bethar voye? Ami bujhi, onek working adult ei voye ashen na. Aaj ami dekhai checkup ar cleaning-e actually ki feel hoy."
        },
        {
          "hook": "Checkup First, No Rush",
          "say": "Prothome amra just aynay dekhi, explain kori ki ache. Kono machine dhorar age apni janben exactly ki hobe. Apni chaile proshno korte paren, amra aste aste agabo."
        },
        {
          "hook": "Vibration Not Pain Feeling",
          "say": "Ultrasonic cleaning mane mostly halka vibration ar pressure, sathe shish-shish pani. Amra olpo olpo kore kori, majhe pause dei. Betha na, oneker kache tickle ba shirshir lage."
        },
        {
          "hook": "Calm Pauses And Explanation",
          "say": "Jodi sensitivity lage, amra thambo, kotha bolbo, tarpor agabo. Apni haat tullei amra stop korbo, etai rule. Seshe teeth halka ar fresh lagbe, voyer moto kichu na."
        }
      ],
      "closingLine": "Voy lagle just eshe kotha bole jan, checkup kore dekhen.",
      "title": "Cleaning After Years Hurts?",
      "why": "Speaks directly to working adults 25-45 who delayed cleaning for years fearing pain."
    },
    {
      "beats": [
        {
          "hook": "Waiting Makes It Harder",
          "say": "Vabchen wait korle betha avoid korben? Actually ulta hoy, joto late korben toto tartar jombe. Tokhon cleaning-e time beshi lage, pressure-o beshi mone hoy."
        },
        {
          "hook": "Hard Brushing Before Visit",
          "say": "Oneke visit er age khub jore brush koren, vaben clean thakle betha kombe. Ete gums aro sensitive hoy, bleeding bare. Normal brush kore ashai enough, baki ta amra dekhbo."
        },
        {
          "hook": "Bleeding Means Avoid Cleaning?",
          "say": "Gums diye blood gele onekei vaben cleaning korano jabe na. Kintu bleeding mane gums-e moyla jome ache. Gentle cleaning ar thik care-e gums aste aste calm hoy."
        },
        {
          "hook": "Small Regular Visits Help",
          "say": "Tai bochorer gap na diye regular halka checkup korle feel kom lage. Short visit, clear explanation, kono surprise na. Friendly way-te korle voy onek kome jay."
        }
      ],
      "closingLine": "Mone hole ekbar eshe situation ta jene nin, pressure niyen na.",
      "title": "Don't Wait Till It Hurts",
      "why": "Corrects busy adults who delay cleaning thinking waiting saves pain and trouble."
    },
    {
      "beats": [
        {
          "hook": "Office Work, No Time",
          "say": "Saradin office, bashay bachcha, nijer teeth last priority. Onek working adult ar ma-baba bochorer por bochor evabei delay koren. Cleaning er kotha uthlei mone hoy, onek betha hobe."
        },
        {
          "hook": "Sitting On Chair Nervous",
          "say": "Chair-e boshei nervous lage, ei bujhi betha shuru hobe. Kintu doctor prothome sudhu kotha bolen, ayna diye check koren. Kono tarahura nei, apni ready holei shuru hoy."
        },
        {
          "hook": "Only Sound And Vibration",
          "say": "Cleaning er shomoy sudhu vibration, pani, ar halka pressure feel hoy. Majhe majhe pause dei, explanation dei ki korchi. Apni chaile haat tule thamte bolte paren."
        },
        {
          "hook": "Walking Out Smiling Light",
          "say": "Seshe aynay dekhe hashi ashe, mukh halka ar fresh lage. Mone hoy, eto bosor voye wait korar dorkar chilo na. Calm thakle prothom step ta ashole shohoj."
        }
      ],
      "closingLine": "Apnar o gap thakle ekdin shanto moto eshe dekhe jan.",
      "title": "I Came After Five Years",
      "why": "Shows parents and working adults someone like them calmly getting through a long-delayed visit."
    }
  ]
}
```

**Tokens:** prompt 640, completion 4457 (reasoning 3423), cached 0

**Observed:**
- Each video's spoken text is about 109, 106, 108 words (60 s of speech is roughly 150).
- The model invented facts the owner never gave: "I Came After Five Years" (the owner never said five years), tartar build-up, and "hard brushing before the visit" as a mistake. This breaks the trust rule and is a risk for a health business.
- This was the most expensive call: 4,457 completion tokens, 3,423 of them reasoning.

## Step 8. Phone JSON (code)
**Input:** step 6's slots and step 7's output.

**Rule:** map the videos to the slots by position, nothing else. The phone shows each `hook` as a slide and never shows the `say` while recording.

**Output** (this is what `GET /public/v1/content-plan/week` would return for the week, minus the id and status fields that come from the database):
```json
{
  "week": {
    "weekStart": "2026-11-23",
    "idea": "Show exactly what a gentle checkup and ultrasonic cleaning feels like after years of gap — mostly vibration and pressure, with calm pauses and explanation throughout.",
    "brief": "Many working adults in Dhanmondi avoid checkup and cleaning for years because they expect pain. This week we show step-by-step what a gentle checkup and ultrasonic cleaning actually feels like. Calm, honest, no fear - just vibration, pressure and clear explanation.",
    "days": [
      {
        "slot": 1,
        "dayIndex": 0,
        "date": "2026-11-23",
        "angle": "problem",
        "beats": [
          {
            "hook": "Years Since Last Cleaning?",
            "say": "Bochorer por bochor cleaning koren ni, karon bethar voye? Ami bujhi, onek working adult ei voye ashen na. Aaj ami dekhai checkup ar cleaning-e actually ki feel hoy."
          },
          {
            "hook": "Checkup First, No Rush",
            "say": "Prothome amra just aynay dekhi, explain kori ki ache. Kono machine dhorar age apni janben exactly ki hobe. Apni chaile proshno korte paren, amra aste aste agabo."
          },
          {
            "hook": "Vibration Not Pain Feeling",
            "say": "Ultrasonic cleaning mane mostly halka vibration ar pressure, sathe shish-shish pani. Amra olpo olpo kore kori, majhe pause dei. Betha na, oneker kache tickle ba shirshir lage."
          },
          {
            "hook": "Calm Pauses And Explanation",
            "say": "Jodi sensitivity lage, amra thambo, kotha bolbo, tarpor agabo. Apni haat tullei amra stop korbo, etai rule. Seshe teeth halka ar fresh lagbe, voyer moto kichu na."
          }
        ],
        "closingLine": "Voy lagle just eshe kotha bole jan, checkup kore dekhen.",
        "title": "Cleaning After Years Hurts?",
        "why": "Speaks directly to working adults 25-45 who delayed cleaning for years fearing pain."
      },
      {
        "slot": 2,
        "dayIndex": 2,
        "date": "2026-11-25",
        "angle": "mistake",
        "beats": [
          {
            "hook": "Waiting Makes It Harder",
            "say": "Vabchen wait korle betha avoid korben? Actually ulta hoy, joto late korben toto tartar jombe. Tokhon cleaning-e time beshi lage, pressure-o beshi mone hoy."
          },
          {
            "hook": "Hard Brushing Before Visit",
            "say": "Oneke visit er age khub jore brush koren, vaben clean thakle betha kombe. Ete gums aro sensitive hoy, bleeding bare. Normal brush kore ashai enough, baki ta amra dekhbo."
          },
          {
            "hook": "Bleeding Means Avoid Cleaning?",
            "say": "Gums diye blood gele onekei vaben cleaning korano jabe na. Kintu bleeding mane gums-e moyla jome ache. Gentle cleaning ar thik care-e gums aste aste calm hoy."
          },
          {
            "hook": "Small Regular Visits Help",
            "say": "Tai bochorer gap na diye regular halka checkup korle feel kom lage. Short visit, clear explanation, kono surprise na. Friendly way-te korle voy onek kome jay."
          }
        ],
        "closingLine": "Mone hole ekbar eshe situation ta jene nin, pressure niyen na.",
        "title": "Don't Wait Till It Hurts",
        "why": "Corrects busy adults who delay cleaning thinking waiting saves pain and trouble."
      },
      {
        "slot": 3,
        "dayIndex": 4,
        "date": "2026-11-27",
        "angle": "story",
        "beats": [
          {
            "hook": "Office Work, No Time",
            "say": "Saradin office, bashay bachcha, nijer teeth last priority. Onek working adult ar ma-baba bochorer por bochor evabei delay koren. Cleaning er kotha uthlei mone hoy, onek betha hobe."
          },
          {
            "hook": "Sitting On Chair Nervous",
            "say": "Chair-e boshei nervous lage, ei bujhi betha shuru hobe. Kintu doctor prothome sudhu kotha bolen, ayna diye check koren. Kono tarahura nei, apni ready holei shuru hoy."
          },
          {
            "hook": "Only Sound And Vibration",
            "say": "Cleaning er shomoy sudhu vibration, pani, ar halka pressure feel hoy. Majhe majhe pause dei, explanation dei ki korchi. Apni chaile haat tule thamte bolte paren."
          },
          {
            "hook": "Walking Out Smiling Light",
            "say": "Seshe aynay dekhe hashi ashe, mukh halka ar fresh lage. Mone hoy, eto bosor voye wait korar dorkar chilo na. Calm thakle prothom step ta ashole shohoj."
          }
        ],
        "closingLine": "Apnar o gap thakle ekdin shanto moto eshe dekhe jan.",
        "title": "I Came After Five Years",
        "why": "Shows parents and working adults someone like them calmly getting through a long-delayed visit."
      }
    ]
  }
}
```

## Cross-step observations
- **Caching:** `cached_tokens` was 0 on all four calls. The task cards put the frame first and the brand context after it. Because each call has a different frame, the brand context can never be a shared cached prefix. Putting the rules and brand context before the frame would let them be reused.
- **Step 1 adds little** in this run. Merging steps 1 and 2 into one call would save one call.

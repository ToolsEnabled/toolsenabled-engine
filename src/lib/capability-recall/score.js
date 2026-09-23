'use strict';

// THE SCORER. PURE: (artifact, query, options) -> ranked candidates.
//
// No I/O, no clock, no globals. Everything it needs arrives as arguments, so
// the tuner can run it ten thousand times over a gold set in a second and the
// tests can score against a hand-built artifact.
//
// BM25F over four fields (identity / title / body / alias) rather than four
// separate BM25 runs added together. The difference matters: BM25's saturation
// term must be applied ONCE to a term's total evidence, otherwise a word that
// appears in three fields is counted as three independent pieces of evidence
// instead of one strong one, and long descriptions beat exact id matches.
//
// TWO PRECISION RULES, LIFTED FROM tools/retrieval/fts-index.js, for the
// reasons recorded there:
//
//   * a 3+ word question must be matched on at least two of its words;
//   * a matched word counts only if it is rare enough to discriminate, OR the
//     tool names it in its own identity or alias.
//
// The second half is not decoration. With only the rarity rule, fts-index
// records that "agent lanes" returned a confident MISS while context/agent-lanes.md
// sat on disk.
//
// AND ONE THE OTHER SURFACES DID NOT HAVE: THE FLOOR IS ABSOLUTE AND THE SCORE
// IS NORMALISED.
//
// tools/grepsaver-orient.js uses a floor RELATIVE to the best hit, and its own
// comments record what that costs: "when the best hit is itself noise every
// near-noise hit clears it... 'gmail thread read' returned openclaw-gateway +
// portfolio-dashboard + servercontrol". A relative floor cannot express "none
// of these is good enough", which is the answer most prompts deserve.
//
// So each candidate's raw BM25F is divided by the most any document could
// possibly have scored on this query (the sum of the query terms' IDF, which
// is BM25's limit as term frequency goes to infinity). The result is a
// coverage fraction in [0, 1): "how much of the available evidence did this
// document actually account for". A fixed threshold on THAT is stable across
// query lengths, which a fixed threshold on raw BM25 is not -- raw scores grow
// with the number of query terms, so one constant would gate a three-word
// prompt and wave through a thirty-word one.

const { corpusCommon, expand, normalizePhrase } = require('./text');
const { grammarVotes } = require('./grammar');

/* BM25's saturation constant. 1.2 is the textbook default and it is left
 * alone: the tuner moves the field weights and the floors, which is where this
 * corpus's behaviour actually lives. A tuner free to move everything overfits
 * a gold set of this size. */
const DEFAULT_K1 = 1.2;

const FIELDS = Object.freeze(['identity', 'title', 'body', 'alias']);

/**
 * Turn a person's words into scored query terms.
 *
 * Each source word yields a raw term and a `~stem` term. The stem carries a
 * discount because "capturing" matching "capture" is real evidence but weaker
 * than "capture" matching "capture", and collapsing the two would make an
 * inflected near-miss indistinguishable from an exact hit.
 */
function prepareQuery(text, constants) {
  const counts = expand(text);
  const terms = [];
  const wordOf = new Map();
  for (const term of counts.keys()) {
    const isStem = term.startsWith('~');
    const word = isStem ? term.slice(1) : term;
    terms.push({ term, word, multiplier: isStem ? constants.stemDiscount : 1 });
    if (!wordOf.has(word)) wordOf.set(word, []);
    wordOf.get(word).push(term);
  }
  /* The word count that the required-terms rule counts against is the count of
   * RAW words the person typed, not the doubled term list. */
  const rawWords = [...new Set([...counts.keys()].filter(term => !term.startsWith('~')))];
  return { terms, rawWords, phrase: normalizePhrase(text) };
}

/**
 * Which action(s) the person's words suggest.
 *
 * THE CONJUNCTION THAT BAG-OF-WORDS CANNOT EXPRESS. A tool is (an action)
 * applied to (an object), and the whole reason the vocabulary is factored is
 * that those two axes are independent. Folding both into searchable text threw
 * that away and cost 68 points of recall: "read" landed in the alias field of
 * all 115 read tools, its IDF collapsed, and "read my email" became two weak
 * independent terms instead of one strong pair.
 *
 * So the object axis stays text -- a namespace's words are specific and IDF
 * handles them properly -- and the action axis is matched HERE, as an
 * agreement between what the query asks for and what the tool's id says it
 * does. That is a conjunction, and it is one signal rather than 120 terms.
 *
 * Asymmetric on purpose: agreement is rewarded, disagreement is NOT punished.
 * Action detection is a guess from a handful of common words and a wrong guess
 * that merely fails to help costs a rank; a wrong guess that actively demotes
 * costs the answer. "what is on my calendar today" needs calendar.list to beat
 * calendar.create, and a bonus on `read` achieves that without needing to be
 * confident enough to suppress anything.
 */
function detectActions(words, actionByWord, rawText = '') {
  if (!actionByWord) return null;
  /* Grammar votes first -- see grammar.js: the action of a QUESTION lives in
   * the function words the tokenizer discards, so "what is on my calendar"
   * detected nothing at all until these were read from the raw text. Pooled
   * with the word-level votes below rather than overriding them; neither
   * source is reliable enough to outrank the other. */
  const counts = grammarVotes(rawText);
  for (const word of words) {
    const actions = actionByWord[word];
    if (!actions) continue;
    for (const action of actions) counts.set(action, (counts.get(action) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const best = Math.max(...counts.values());
  /* Every action the query names as strongly as any other. A prompt saying
   * both "show" and "send" genuinely suggests two, and narrowing to one by
   * tie-break would be inventing confidence. */
  return new Set([...counts.entries()].filter(([, count]) => count === best).map(([action]) => action));
}

function idfOf(documentCount, documentFrequency) {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * Score every document that shares at least one term with the query.
 *
 * `allowedIds` -- when given, a Set of tool ids this session may actually call.
 * Filtering happens BEFORE the limit is applied, so a withheld tool never
 * silently consumes one of the three slots the caller asked for.
 */
function score(artifact, queryText, options = {}) {
  const constants = { ...artifact.constants, ...(options.constants || {}) };
  const { docs, postings, df, avgLen, N } = artifact;
  const allowedIds = options.allowedIds instanceof Set ? options.allowedIds : null;
  const query = prepareQuery(queryText, constants);
  const detectedActions = detectActions(query.rawWords, artifact.actionByWord, queryText);

  if (query.terms.length === 0) {
    return { candidates: [], query, evidence: 0, reason: 'NO_SEARCHABLE_TERMS' };
  }

  /* THE DENOMINATOR, AND THE TWO THINGS IT HAS TO ACCOUNT FOR.
   *
   * (1) EVERY QUERY TERM COUNTS, INCLUDING THE ONES NO TOOL HAS. This loop
   * originally skipped absent terms, and that single omission produced a 45%
   * false-positive rate on the negative set. "hello there, how are you today"
   * has one term the catalogue knows -- "today", which appears in three
   * calendar descriptions -- and four it does not. Skipping the absent four
   * made "today" the whole question, so calendar.list scored 0.905 and the
   * block spoke over a greeting. An absent word is not missing evidence; it is
   * evidence that the question is about something else, and it is the MOST
   * informative kind, so it enters at the idf a df of zero earns.
   *
   * (2) A PRIOR MASS, SO SHORT QUERIES CANNOT REACH CERTAINTY CHEAPLY. Without
   * it a one-word prompt that matches its one word scores exactly 1.0 no matter
   * how thin that word is: "stop" returned browser.stop at 0.937. The prior is
   * a constant in the denominator -- the evidence a query would need to carry
   * before a full match means anything -- so coverage becomes "how much of the
   * available evidence did this document account for, given how little was
   * asked". "stop" lands at 0.44 and "take a picture of what is on my screen"
   * at 0.73, which is the separation the floor needs and could not previously
   * express. */
  let evidence = constants.priorMass;
  let absentMass = 0;
  const active = [];
  const presentMass = [];
  for (const entry of query.terms) {
    const documentFrequency = df[entry.term] || 0;
    const idf = idfOf(N, documentFrequency);
    if (documentFrequency > 0) {
      presentMass.push(entry.multiplier * idf);
      active.push({ ...entry, idf, df: documentFrequency });
      continue;
    }
    /* AN ABSENT WORD COUNTS, BUT NOT AT FULL PRICE.
     *
     * At full idf(0) -- the maximum, since nothing is rarer than a word no tool
     * has -- absent words sank the greetings correctly and then also sank every
     * detailed request, because detail is made of words the catalogue does not
     * contain. "save the report to disk as a markdown file" scored 0.407 for
     * host.write_file, the right tool ranked first, purely because "report" and
     * "markdown" are not in any description. The more precisely a person asked,
     * the worse they did, which is backwards.
     *
     * So the penalty is a tuned FRACTION of idf(0): heavy enough that a prompt
     * made mostly of unknown words cannot reach certainty on one incidental
     * match, light enough that naming a filename or a person does not cost you
     * the answer. */
    absentMass += entry.multiplier * idf * constants.absentWeight;
  }
  if (active.length === 0) {
    return { candidates: [], query, evidence, reason: 'NO_QUERY_TERM_IS_IN_THE_CATALOGUE' };
  }

  /* THE DENOMINATOR IS BUILT FROM THE QUESTION'S CORE, NOT ALL OF IT.
   *
   * Measured, and it is the single largest finding in this build. Against a
   * gold set whose wording had shaped the lexicon, recall@3 read 100%. Against
   * a fresh set written afterwards it read 14%, and the reason was not the
   * ranking -- it was that a colloquial sentence carries framing the catalogue
   * will never contain. "which processes are hogging the machine" asks one
   * thing in six words, and requiring host.list_processes to account for
   * "hogging" and "machine" as well as "processes" put the right answer, ranked
   * first, at 0.279 against a 0.42 floor.
   *
   * Intent lives in a request's few most informative words. So the denominator
   * is the top `focusTerms` present terms by weighted IDF -- the core of what
   * was asked -- and the rest is framing that a tool is not penalised for
   * missing. The numerator still counts EVERY matched term, so covering the
   * framing too is rewarded; coverage is clamped at 1.
   *
   * The absent-word penalty is capped for the same reason. Three words the
   * catalogue has never heard of tell you the question is off-topic; ten do not
   * tell you three times more, they just tell you the person writes in
   * sentences. Uncapped, verbosity alone silenced the block. */
  presentMass.sort((a, b) => b - a);
  const focus = presentMass.slice(0, Math.max(1, constants.focusTerms));
  for (const mass of focus) evidence += mass;
  evidence += Math.min(absentMass, constants.maxAbsentMass);

  const accumulated = new Map();
  for (const entry of active) {
    const list = postings[entry.term];
    if (!list) continue;
    for (const posting of list) {
      const documentIndex = posting[0];
      let state = accumulated.get(documentIndex);
      if (!state) {
        state = { raw: 0, matchedWords: new Set(), namedWords: new Set(), discriminating: new Set(), strongWords: new Set() };
        accumulated.set(documentIndex, state);
      }
      /* BM25F: one length-normalised, field-weighted pseudo term frequency,
       * then one saturation. */
      let tf = 0;
      for (let f = 0; f < FIELDS.length; f += 1) {
        const raw = posting[f + 1];
        if (!raw) continue;
        const field = FIELDS[f];
        const length = docs[documentIndex].len[field] || 0;
        const average = avgLen[field] || 1;
        const b = constants.b[field];
        tf += constants.weights[field] * raw / (1 - b + b * (length / average));
      }
      if (tf <= 0) continue;
      state.raw += entry.multiplier * entry.idf * (tf / (constants.k1 + tf));
      state.matchedWords.add(entry.word);
      /* "Named in its own IDENTITY" -- the escape hatch that keeps a common
       * word from disqualifying the tool actually called that.
       *
       * IDENTITY OR OBJECT VOCABULARY. This once excluded the alias field, for
       * a good reason that stopped applying: back then `alias` was a mixed bag
       * of hand-written phrases including generic verbs, and a single generic
       * alias word could bypass both precision rules on its own.
       *
       * Since the factorisation the alias field holds ONLY a namespace's object
       * vocabulary -- "inbox" for gmail, for example. That is not
       * a loose association, it is what the tool family IS in a person's words,
       * and it has the same claim `agent_comms.send` has on "send".
       *
       * WITH ONE GUARD. The field also carries the words of multi-word idioms,
       * and an idiom drags its function words in with it: "tell the other one"
       * put `other` and `one` into agent_comms.send, both counted as namings,
       * and "no, the other one" was recommended agent_comms.send at 0.471. A
       * corpus-common word is never what a tool is CALLED, whatever field it
       * lands in, so it cannot buy the hatch. Identity is exempt: a tool named
       * `audit.read` has a real claim on "read" however common it is. */
      if (posting[1] > 0 || (posting[4] > 0 && !corpusCommon(entry.term))) {
        state.namedWords.add(entry.word);
      }
      if (entry.df <= N * constants.commonFraction && !corpusCommon(entry.term)) {
        state.discriminating.add(entry.word);
      }
      /* A WORD SO SPECIFIC THAT ONE OF IT IS ENOUGH.
       *
       * The two-word rule exists to stop a WEAK single match, and it was also
       * throwing away strong ones. Measured: "is there anything sitting in my
       * inbox from the bank" returned nothing, because gmail.list matched
       * "inbox" -- a word that appears against five tools in the whole
       * catalogue and is Gmail's on every one of them -- and "anything", which
       * appears against 126 and discriminates nothing. One qualifying word, so
       * the rule dropped the only correct answer in the corpus.
       *
       * "Strong" is deliberately narrow: rare across the catalogue AND named by
       * this tool in its identity or its curated aliases, so it is a deliberate
       * naming rather than a word that happens to sit in one description. At
       * df<=5 of 272 this admits `inbox`, `terraform`, `screenshot`; at df=8 it
       * would admit `other`, which is how "no, the other one" once returned
       * workspace.list. */
      if (entry.df <= N * constants.strongTermFraction && (posting[1] > 0 || posting[4] > 0)) {
        state.strongWords.add(entry.word);
      }
    }
  }

  /* Curated multi-word intents. A phrase is a claim about what the WHOLE
   * sentence means, which single-term scoring structurally cannot make: "check
   * for updates" is three common words and one intent. The boost is additive
   * in normalised space and bounded, so a phrase can lift a tool into
   * contention but cannot by itself outrank real term evidence. */
  const phraseHits = new Map();
  if (query.phrase) {
    for (const entry of artifact.phrases) {
      if (!query.phrase.includes(entry.p)) continue;
      for (const documentIndex of entry.tools) {
        const previous = phraseHits.get(documentIndex);
        if (previous === undefined || entry.p.length > previous.length) {
          phraseHits.set(documentIndex, entry.p);
        }
        if (!accumulated.has(documentIndex)) {
          accumulated.set(documentIndex, {
            raw: 0, matchedWords: new Set(), namedWords: new Set(), discriminating: new Set(), strongWords: new Set(),
          });
        }
      }
    }
  }

  /* TWO WORDS OF THE QUESTION, NOT THREE.
   *
   * tools/retrieval/fts-index.js requires two matched words only once a topic
   * reaches three, which is right for a corpus of prose documents where one
   * rare word genuinely identifies a document. It is wrong for a catalogue of
   * 272 short tool descriptions: "no, the other one" is two content words that
   * both appear somewhere, and it returned workspace.list at 0.930. Requiring
   * both words of a two-word prompt costs nothing real -- a genuine two-word
   * request names its object and its action, and the tool has both -- and it
   * also fixed "deploy the website", where web.fetch had matched on "website"
   * alone while every deployment tool matched on "deploy" alone. */
  const requiredWords = query.rawWords.length >= 2 ? 2 : 1;
  const candidates = [];
  for (const [documentIndex, state] of accumulated) {
    const document = docs[documentIndex];
    if (allowedIds && !allowedIds.has(document.id)) continue;

    const phraseMatched = phraseHits.get(documentIndex) || null;
    const agreesOnAction = Boolean(detectedActions && document.action && detectedActions.has(document.action));
    /* ONE WORD HAS TO BE A NAMING, NOT A MENTION.
     *
     * When the whole prompt is a single content word there is no second word to
     * corroborate it, so the one match has to be deliberate: the word must sit
     * in the tool's identity or in its curated aliases, never only in the prose
     * of its description. Measured: "leave it for now" reduces to "leave",
     * which appears in one description's body, and workstation.initialize_cursor_state
     * cleared the floor by a thousandth. A tool that happens to use your only
     * word in a sentence has not been named by it. */
    if (!phraseMatched && query.rawWords.length === 1
      && state.namedWords.size === 0 && state.strongWords.size === 0) continue;

    if (!phraseMatched && state.strongWords.size === 0) {
      /* THE ACTION AGREEING IS EVIDENCE, AND THESE RULES COUNT EVIDENCE.
       *
       * Measured, and it was the largest single defect in the factored build:
       * "look at my screen" detected action `read`, matched object `screen`,
       * and returned NOTHING -- because the two-word rule counted only matched
       * WORDS, saw one, and discarded the candidate before the action bonus
       * could ever apply. The conjunction the whole factorisation exists to
       * express was being thrown away one step before it was used.
       *
       * A tool that matches the object a person named AND performs the action
       * they asked for has two independent pieces of evidence. That the second
       * arrived from the id rather than from a word does not make it worth
       * less. */
      const actionEvidence = agreesOnAction ? 1 : 0;
      /* Rule 1: enough of the question was accounted for at all. */
      if (state.matchedWords.size + actionEvidence < requiredWords) continue;
      /* Rule 2: enough of it on evidence that discriminates. */
      let qualifying = actionEvidence;
      for (const word of state.matchedWords) {
        if (state.discriminating.has(word) || state.namedWords.has(word)) qualifying += 1;
      }
      if (qualifying < requiredWords) continue;
    }

    const normalised = Math.min(1, state.raw / evidence);
    /* TWO NUMBERS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS.
     *
     * `confidence` decides whether to speak at all: how much of what the person
     * asked did this tool actually account for. A matched multi-word idiom
     * raises it, because that idiom IS content the tool accounted for.
     *
     * `score` decides the order among tools worth speaking about, and the
     * action agreement lives HERE and only here.
     *
     * Measured, and it was worth 15 points of false positives: applying the
     * action bonus to the gating number let "hello there, how are you today"
     * clear the floor at 0.479 on a lexical score of 0.329, purely because the
     * grammar said "read" and calendar.list reads. Agreeing on a verb is a
     * reason to rank a tool above another tool. It is not a reason to believe
     * the question was about tools. */
    let confidence = normalised;
    if (phraseMatched) confidence = Math.min(1, confidence + constants.phraseBoost);
    let boosted = confidence;
    if (agreesOnAction) boosted = Math.min(1, boosted + constants.actionBoost);
    candidates.push({
      id: document.id,
      index: documentIndex,
      score: boosted,
      confidence,
      lexical: normalised,
      phrase: phraseMatched,
      action: document.action,
      actionAgrees: agreesOnAction,
      matchedWords: [...state.matchedWords],
      namedWords: [...state.namedWords],
      strongWords: [...state.strongWords],
    });
  }

  /* WITHIN A HAIR, THE GENERAL FORM WINS.
   *
   * "take a picture of what is on my screen" scored screen.capture,
   * screen.capture_region and screen.capture_monitor at 0.943 apiece -- they
   * share an alias entry, so they should tie -- and floating-point noise put
   * capture_region first. A person asking for a picture of their screen wants
   * screen.capture; capture_region is a specialisation that needs a rectangle
   * they did not give. Recommending the specialisation is not wrong enough to
   * be caught by any metric and is wrong every time, so ties inside a small
   * band are broken toward the shorter id, which in this catalogue is reliably
   * the general form. */
  candidates.sort((a, b) => {
    const difference = b.score - a.score;
    if (Math.abs(difference) > constants.tieBand) return difference;
    return a.id.length - b.id.length || a.id.localeCompare(b.id);
  });
  return { candidates, query, evidence, detectedActions: detectedActions ? [...detectedActions] : null, reason: candidates.length ? 'SCORED' : 'NO_CANDIDATE_PASSED_THE_PRECISION_RULES' };
}

/**
 * Score, then apply the floor and the limit.
 *
 * `floor` is the absolute normalised threshold for this mode. Below it the
 * answer is an empty list, and that is a real answer -- see the header.
 */
function rank(artifact, queryText, { floor, limit, allowedIds, constants } = {}) {
  const scored = score(artifact, queryText, { allowedIds, constants });
  const threshold = typeof floor === 'number' ? floor : artifact.constants.floorAuto;
  const kept = scored.candidates.filter(candidate => candidate.confidence >= threshold);
  const bounded = typeof limit === 'number' ? kept.slice(0, limit) : kept;
  return {
    ...scored,
    floor: threshold,
    results: bounded,
    belowFloor: scored.candidates.length - kept.length,
    bestRejected: kept.length === 0 && scored.candidates.length > 0
      ? {
          id: scored.candidates[0].id,
          // The floor is applied to confidence, not the separately boosted
          // ranking score. Keep the floor-comparable value under `score` for
          // existing consumers and expose the ordering value explicitly.
          score: scored.candidates[0].confidence,
          rankScore: scored.candidates[0].score,
        }
      : null,
  };
}

module.exports = Object.freeze({
  DEFAULT_K1,

  FIELDS,
  detectActions,
  idfOf,
  prepareQuery,
  rank,
  score,
});

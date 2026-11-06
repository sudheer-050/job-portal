'use strict';

// JD keyword extraction and CV coverage. Diagnostic only: it reports which job
// keywords the resume already evidences and never injects keywords into it.

const STOP_WORDS = new Set(`a about above across after again all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had has have having he her here
hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same
she should so some such than that the their them then there these they this those through to too under until up very was we
were what when where which while who whom why will with would you your yours`.split(/\s+/));

const GENERIC_WORDS = new Set(`ability able across active additional apply applicants applicant benefits candidate candidates
career company compensation culture day days description diverse diversity duties employer employees employment environment equal
etc excellent experience experienced familiarity good great growth help including include includes join knowledge like looking
make mission must need needs new offer opportunities opportunity organization overview paid part people perks plus position
preferred prior provide qualifications qualified related required requirements responsibilities responsible role roles salary
seeking skills strong successful team teams time to-be understanding using want we're well work working year years you'll
you're ideal highly proven within based per via etc. deliver delivering deliverables own owning drive driving ensure
ensuring support supporting partner partnering collaborate collaborating build building across`.split(/\s+/));

// Multi-word and short terms that single-word tokenising would lose.
const SKILL_PHRASES = [
    'machine learning', 'deep learning', 'data science', 'data engineering', 'data analysis', 'data analytics',
    'data modeling', 'data visualization', 'data warehouse', 'natural language processing', 'computer vision',
    'project management', 'program management', 'product management', 'stakeholder management', 'change management',
    'customer success', 'customer service', 'account management', 'solution architecture', 'solutions architecture',
    'software engineering', 'full stack', 'front end', 'back end', 'rest api', 'rest apis', 'ci/cd', 'unit testing',
    'test automation', 'agile', 'scrum', 'kanban', 'business intelligence', 'business analysis', 'business analyst',
    'requirements gathering', 'user stories', 'process improvement', 'root cause analysis', 'a/b testing',
    'financial modeling', 'financial analysis', 'supply chain', 'quality assurance', 'cloud computing',
    'cross-functional', 'public speaking', 'technical writing', 'sales engineering', 'pre-sales', 'presales',
    'object-oriented', 'microservices', 'distributed systems', 'system design', 'prompt engineering',
    'large language models', 'llm', 'llms', 'generative ai', 'rag', 'etl', 'elt', 'sql', 'nosql', 'node.js',
    'react.js', 'vue.js', 'next.js', 'c++', 'c#', '.net', 'power bi', 'google analytics', 'tableau',
];

const KNOWN_TERMS = new Set([
    'python', 'java', 'javascript', 'typescript', 'go', 'golang', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r',
    'sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'kafka', 'spark', 'hadoop', 'airflow', 'dbt', 'snowflake',
    'bigquery', 'redshift', 'databricks', 'aws', 'azure', 'gcp', 'kubernetes', 'docker', 'terraform', 'ansible', 'jenkins',
    'git', 'github', 'gitlab', 'linux', 'react', 'angular', 'vue', 'node', 'express', 'django', 'flask', 'fastapi', 'spring',
    'graphql', 'rest', 'api', 'apis', 'html', 'css', 'tailwind', 'figma', 'tableau', 'looker', 'excel', 'salesforce',
    'hubspot', 'jira', 'confluence', 'sap', 'oracle', 'workday', 'servicenow', 'splunk', 'datadog', 'pytorch', 'tensorflow',
    'pandas', 'numpy', 'scikit-learn', 'selenium', 'cypress', 'playwright', 'jest', 'pytest', 'agile', 'scrum', 'okr', 'kpi',
    'saas', 'b2b', 'b2c', 'crm', 'erp', 'seo', 'sem', 'gdpr', 'hipaa', 'soc2', 'sox', 'pci', 'iso27001',
]);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(text) {
    return String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function tokenize(text) {
    return normalize(text).match(/[a-z0-9][a-z0-9+#.\-/]*[a-z0-9+#]|[a-z0-9]/g) || [];
}

// Occurrences of a term as a whole word/phrase, tolerant of simple plurals.
function countTerm(haystack, term) {
    const text = normalize(haystack);
    const needle = normalize(term).trim();
    if (!needle) return 0;
    const pattern = new RegExp(`(?<![a-z0-9+#])${escapeRegExp(needle)}(?:s|es)?(?![a-z0-9+#])`, 'g');
    return (text.match(pattern) || []).length;
}

function isRequirementLine(line) {
    return /\b(must|required|requirements?|qualifications?|minimum|proficien\w*|expertise|you have|you bring)\b/i.test(line);
}

function extractKeywords(jobText, { limit = 24 } = {}) {
    const text = String(jobText || '');
    if (!text.trim()) return [];
    const scores = new Map();
    const bump = (term, amount) => scores.set(term, (scores.get(term) || 0) + amount);

    const lines = text.split(/\r?\n|(?<=[.;])\s+/);
    for (const line of lines) {
        const required = isRequirementLine(line);
        const lineBonus = required ? 1 : 0;
        const seen = new Set();
        for (const phrase of SKILL_PHRASES) {
            if (countTerm(line, phrase)) { bump(phrase, 2 + lineBonus); seen.add(phrase); }
        }
        const lineTokens = tokenize(line);
        for (const token of lineTokens) {
            if (token.length < 2 || STOP_WORDS.has(token) || GENERIC_WORDS.has(token) || /^\d+$/.test(token)) continue;
            if (seen.has(token)) continue;
            if (KNOWN_TERMS.has(token)) bump(token, 2 + lineBonus);
            else if (token.length >= 4 && /[a-z]/.test(token)) bump(token, 0.5 + (lineBonus ? 0.25 : 0));
        }
    }

    // Plain words must repeat to count, and repetition is capped so boilerplate nouns can never
    // outweigh a named skill; vocabulary terms and phrases qualify on a single mention.
    for (const [term, score] of scores) {
        if (!KNOWN_TERMS.has(term) && !SKILL_PHRASES.includes(term) && score > 2.5) scores.set(term, 2.5);
    }
    const ranked = [...scores.entries()]
        .filter(([term, score]) => score >= 2 || KNOWN_TERMS.has(term) || SKILL_PHRASES.includes(term))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    // Drop a single word already covered by a kept phrase containing it.
    const kept = [];
    for (const [term, score] of ranked) {
        if (!term.includes(' ') && kept.some(item => item.term.includes(' ') && item.term.split(/\s+/).includes(term) && item.score >= score)) continue;
        kept.push({ term, score });
        if (kept.length >= limit) break;
    }
    return kept;
}

function keywordCoverage(jobText, resumeText, options = {}) {
    const keywords = extractKeywords(jobText, options);
    const items = keywords.map(({ term, score }) => {
        const count = countTerm(resumeText, term);
        return { term, weight: score, count, status: count === 0 ? 'missing' : count === 1 ? 'thin' : 'present' };
    });
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    const earned = items.reduce((sum, item) => sum + item.weight * (item.status === 'present' ? 1 : item.status === 'thin' ? 0.5 : 0), 0);
    return {
        coverage: totalWeight ? Math.round((earned / totalWeight) * 100) : 0,
        present: items.filter(item => item.status === 'present'),
        thin: items.filter(item => item.status === 'thin'),
        missing: items.filter(item => item.status === 'missing'),
        items,
    };
}

module.exports = { KNOWN_TERMS, SKILL_PHRASES, countTerm, escapeRegExp, extractKeywords, keywordCoverage, normalize, tokenize };

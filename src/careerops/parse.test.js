'use strict';

// A resume whose text came out of a PDF: every line wrapped at a fixed width, wrapped lines that start with a capital letter,
// a blank line in the middle of a bullet, a word split by a hyphen, headings in capitals with "&", and roles listed out of order.
// All the people, employers and numbers here are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATE_RANGE, certificationLines, headingType, parseEntries, wrapWidthOf } = require('./parse');
const { parseResume, renderMarkdown, tailorResume, verifyTailoredFacts } = require('./resume');
const { optimizeForAts } = require('./ats');

const WIDTH = 104;
/** Wrap text the way a PDF does: at a word boundary once the line is full. The bullet marker stays on the first line. */
function wrap(text, marker = '') {
    const lines = [];
    let line = marker;
    for (const word of text.split(' ')) {
        if ((line + ' ' + word).trim().length > WIDTH && line.trim()) { lines.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines;
}
const bullet = text => wrap(text, '•');
/** A bullet whose line breaks are chosen, so that the second line starts with a capital or an acronym. */
const physical = parts => [`• ${parts[0]}`, ...parts.slice(1)];

const P = {
    ops1: ['Analyzed regional sales datasets and produced insights using Python (Pandas, NumPy) and', 'SQL, processing 1M+ records with statistical rigor'],
    ops2: ['Built interactive Power BI dashboards for performance tracking and business metrics visualization; the', 'KPIs driving 10% gains in sales and customer retention'],
    // a word split by a hyphen at the end of a line
    eng2: ['Conducted yield and quality analytics across production lines, identifying bottlenecks and process improvements for the full-', 'stack of plant operations'],
    tech: ['Tech Stack: Python, FastAPI, SQLAlchemy, SQLite, APScheduler, Click, Jinja2, pytest, GitHub Actions, MIT', 'License'],
};
const B = {
    ops1: P.ops1.join(' '),
    ops2: P.ops2.join(' '),
    ops3: 'Developed predictive models for customer churn and lifetime value estimation, enabling data-driven business strategy',
    ops4: 'Ran A/B testing and statistical analysis to optimize business processes and validate hypotheses across multiple campaigns',
    eng1: 'Supported process optimization projects and quality analytics in manufacturing; reduced filtration process time from 8 hours to 45 minutes',
    eng2: P.eng2.join(''), // the hyphen at the end of the first line is joined to the next word
    eng3: 'Trained 8+ team members on data analysis techniques and process documentation best practices',
    adv1: 'Advised 2 local electronics retail stores on inventory optimization, sales analytics, and business performance improvement',
    prj1: 'Built and operate a public site with four live apps and a download page for the open-source agent platform that runs the whole suite',
    prj2: 'Added failover to a backup runtime on quota, rate-limit, authentication, or availability errors, with each switch recorded on the issue timeline and the CLIs',
    tech: P.tech.join(' '),
};

const SOURCE = [
    'JANE Q EXAMPLE ',
    'Chicago, IL | (312) 555-0101 | jane@example.com | linkedin.com/in/janeexample | github.com/janeexample ',
    'PROFESSIONAL SUMMARY ',
    ...wrap('Data-driven analytics professional with an MBA and a B.Tech in Chemical Engineering. Experienced in building data applications and machine learning pipelines. Proficient in Python, SQL and Power BI.'),
    'EDUCATION ',
    'Master of Business Analytics | Northwind University School of Business ',
    'Graduated June 2026 | GPA: 3.9/4.0 ',
    'B.Tech in Chemical Engineering | Example Institute of Technology, India ',
    'TECHNICAL SKILLS & TOOLS ',
    'Programming Languages: Python, SQL, R, JavaScript (Node.js) ',
    ...wrap('Cloud & DevOps: AWS (EC2, S3, SageMaker), Docker, Docker Compose, Cloudflare Tunnel, GitHub, GitHub Actions (CI)'),
    'PROFESSIONAL EXPERIENCE ',
    // the roles are NOT in date order: the volunteer role (Aug 2023 - Feb 2024) is newer than the engineering job (ends Jul 2023)
    'Data Analytics Intern | Unified Mentorship ',
    'March 2024 – June 2024 | Remote ',
    ...physical(P.ops1), ...physical(P.ops2), ...bullet(B.ops3),
    '', // a blank line that falls in the middle of the experience at a page break
    ...bullet(B.ops4),
    'Junior Engineer | Example Labs Limited ',
    'February 2021 – July 2023 | Hyderabad, India ',
    ...bullet(B.eng1), ...physical(P.eng2), ...bullet(B.eng3),
    'Independent Business Consultant (Volunteer) ',
    'August 2023 – February 2024 ',
    ...bullet(B.adv1),
    '',
    'PROJECTS & PORTFOLIO ',
    'Personal projects below were built with the help of AI coding tools, and they are still being worked on ',
    'and improved. ',
    'Example Suite — Self-Hosted App Collection (Ongoing) ',
    'Live at example.org | Messenger, assistant, analyst and job board ',
    ...bullet(B.prj1),
    'Agent Platform — Self-Hosted Multi-Agent Operations (Ongoing) ',
    ...wrap('Local-first platform for coordinating AI agents, projects, approvals, repositories, chat, automations, and execution history'),
    'GitHub: github.com/janeexample/agents | Version 0.2.1 | MIT License ',
    ...bullet(B.prj2),
    ...physical(P.tech),
    'CERTIFICATIONS & PROFESSIONAL DEVELOPMENT ',
    'Machine Learning Specialization | DeepLearning.AI & Stanford Online ',
    'Completed August 2026 | Coursera ',
    ...wrap('Comprehensive specialization covering supervised and unsupervised learning, advanced algorithms, reinforcement learning, and system design. Includes three courses:'),
    '   • Supervised Machine Learning: Regression and Classification — foundational regression and classification ',
    'algorithms with practical applications ',
    'Career Essentials in Data Analysis | Microsoft and LinkedIn ',
    'Completed May 2024 | LinkedIn Learning ',
    'Agile Requirements Foundations | LinkedIn Learning ',
    'Instructor: Angela Example ',
    'ACADEMIC PROJECTS & CAPSTONE ',
    'Industry Classification (Capstone) | MGT 599 ',
    '• Developed an ML classification system using ensemble methods to categorize industry segments ',
    'LEADERSHIP & ACTIVITIES ',
    'Class Representative | Example Institute ',
    'February 2017 – August 2018 ',
    '• Organized and managed a campus event, coordinating with 200+ students ',
    'ADDITIONAL SKILLS & INTERESTS ',
    'MLOps: Model monitoring, performance tracking, Docker containerization ',
    'KEY COMPETENCIES ',
    'Machine Learning Engineering • NLP & Text Classification • Data Analysis & Analytics • Business Intelligence ',
].join('\n');

const parsed = parseResume(SOURCE);

test('the fixture has the quirks being tested', () => {
    const lines = SOURCE.split('\n');
    assert.ok(lines.some(line => /^SQL, processing/.test(line)), 'a wrapped line starts with "SQL,"');
    assert.ok(lines.some(line => /^KPIs driving/.test(line)), 'a wrapped line starts with an acronym');
    assert.ok(lines.includes(''), 'there is a blank line inside the experience');
    assert.ok(lines.includes('License'), 'a one-word line that looks like a heading ends a wrapped sentence');
    const width = wrapWidthOf(lines.map(line => line.trim()).filter(Boolean));
    assert.ok(width >= 90, `the document has a wrap width: ${width}`);
    for (const line of lines.filter(line => /^• (Analyzed|Built interactive|Tech Stack)/.test(line))) assert.ok(line.trim().length >= width * 0.8, `a line before a wrap is full width: ${line}`);
});

test('headings written in capitals with "&" are recognised, including ones that are not on a fixed list', () => {
    const type = text => headingType(text, { known: true });
    assert.equal(type('PROJECTS & PORTFOLIO'), 'projects');
    assert.equal(type('ACADEMIC PROJECTS & CAPSTONE'), 'projects');
    assert.equal(type('CERTIFICATIONS & PROFESSIONAL DEVELOPMENT'), 'certifications');
    assert.equal(type('TECHNICAL SKILLS & TOOLS'), 'skills');
    assert.equal(type('ADDITIONAL SKILLS & INTERESTS'), 'skills');
    assert.equal(type('KEY COMPETENCIES'), 'skills');
    assert.equal(type('LEADERSHIP & ACTIVITIES'), 'other');
    assert.equal(type('PROFESSIONAL EXPERIENCE'), 'experience');
    assert.equal(type('References'), 'filler');
    assert.equal(headingType('JANE Q EXAMPLE', { known: false }), null, 'the name at the top is not a heading');
    assert.equal(type('Project Manager'), null, 'a job title is not a heading');
    assert.equal(type('Senior Data Analyst | Acme'), null);
});

test('a word that ends a wrapped sentence is not mistaken for a heading', () => {
    assert.equal(headingType('License', { afterWrapped: true }), null);
    assert.equal(headingType('Training', { afterWrapped: true }), null);
    assert.equal(headingType('Certifications', { afterWrapped: false }), 'certifications', 'but a real heading still counts');
    assert.equal(headingType('CERTIFICATIONS', { afterWrapped: true }), 'certifications', 'capitals are always a heading');
});

test('experience: every role, with its dates, and every bullet joined back into one piece', () => {
    assert.equal(parsed.experience.length, 3, JSON.stringify(parsed.experience.map(e => e.header)));
    assert.deepEqual(parsed.experience.map(entry => entry.header), [
        ['Data Analytics Intern | Unified Mentorship', 'March 2024 – June 2024 | Remote'],
        ['Junior Engineer | Example Labs Limited', 'February 2021 – July 2023 | Hyderabad, India'],
        ['Independent Business Consultant (Volunteer)', 'August 2023 – February 2024'],
    ]);
    assert.deepEqual(parsed.experience.map(entry => entry.bullets.length), [4, 3, 1]);
    assert.deepEqual(parsed.experience[0].bullets, [B.ops1, B.ops2, B.ops3, B.ops4], 'wrapped lines, even ones starting with "SQL," or "KPIs", are part of their bullet');
    assert.deepEqual(parsed.experience[2].bullets, [B.adv1]);
});

test('experience never contains lines that belong to another section', () => {
    const everything = parsed.experience.flatMap(entry => [...entry.header, ...entry.bullets]).join('\n');
    for (const stray of ['Example Suite', 'Agent Platform', 'GitHub: github.com', 'Machine Learning Specialization', 'Class Representative', 'Personal projects']) assert.ok(!everything.includes(stray), stray);
});

test('projects are their own section: titles, descriptions, links and bullets, without the introduction', () => {
    assert.equal(parsed.projects.length, 3);
    assert.equal(parsed.projects[0].header[0], 'Example Suite — Self-Hosted App Collection (Ongoing)');
    assert.ok(!parsed.projects.some(entry => entry.header.some(line => /Personal projects below/.test(line))), 'the introduction belongs to no project');
    const agent = parsed.projects[1];
    assert.equal(agent.header[0], 'Agent Platform — Self-Hosted Multi-Agent Operations (Ongoing)');
    assert.ok(agent.header.some(line => line.startsWith('Local-first platform') && line.endsWith('execution history')), 'a wrapped description is one line');
    assert.deepEqual(agent.bullets, [B.prj2, B.tech], '"License" is the end of the Tech Stack bullet');
    assert.equal(parsed.projects[2].header[0], 'Industry Classification (Capstone) | MGT 599', 'a second projects section is added');
});

test('certifications: one line per certification, with its date, without descriptions or sub-bullets', () => {
    assert.deepEqual(parsed.certifications, [
        'Machine Learning Specialization | DeepLearning.AI & Stanford Online · Completed August 2026 | Coursera',
        'Career Essentials in Data Analysis | Microsoft and LinkedIn · Completed May 2024 | LinkedIn Learning',
        'Agile Requirements Foundations | LinkedIn Learning',
    ]);
    assert.deepEqual(certificationLines(['- Deep Learning Specialization -- DeepLearning.AI', '- Databricks Fundamentals -- Databricks']), ['Deep Learning Specialization -- DeepLearning.AI', 'Databricks Fundamentals -- Databricks'], 'a plain list of bullets is a list of certifications');
});

test('the other sections are read too', () => {
    assert.equal(parsed.name, 'JANE Q EXAMPLE');
    assert.equal(parsed.contact.email, 'jane@example.com');
    assert.deepEqual(parsed.education, ['Master of Business Analytics | Northwind University School of Business', 'Graduated June 2026 | GPA: 3.9/4.0', 'B.Tech in Chemical Engineering | Example Institute of Technology, India']);
    assert.ok(parsed.skills.includes('GitHub Actions (CI)') && parsed.skills.includes('Docker Compose'), `a wrapped skills line keeps its items: ${JSON.stringify(parsed.skills)}`);
    assert.ok(parsed.skills.includes('Machine Learning Engineering') && parsed.skills.includes('NLP & Text Classification'), 'the competencies list is read');
    assert.ok(parsed.skills.includes('Model monitoring'), 'additional skills are read');
    assert.ok(parsed.summary.startsWith('Data-driven analytics professional') && parsed.summary.endsWith('SQL and Power BI.'));
    assert.deepEqual(parsed.other.map(section => section.title), ['LEADERSHIP & ACTIVITIES']);
});

test('a tailored resume from this text has the right roles, in date order, and passes the fact check', async () => {
    const job = { title: 'Data Analyst', company: 'Northwind', description: 'Requirements:\n- SQL and Python\n- Power BI dashboards\n- A/B testing and statistical analysis' };
    const profile = { full_name: 'Jane Q Example', phone: '(312) 555-0101', experience_years: 3 };
    const out = await optimizeForAts({ resumeText: SOURCE, job, profile, target: 90 });
    const built = out.best.built;
    assert.equal(built.factCheck.ok, true);
    assert.equal(verifyTailoredFacts(built.tailored, SOURCE, profile).ok, true);
    assert.equal(built.pages, 1);
    const roles = built.tailored.experience.map(entry => entry.header[0]);
    assert.deepEqual(roles, ['Data Analytics Intern | Unified Mentorship', 'Independent Business Consultant (Volunteer)', 'Junior Engineer | Example Labs Limited'], 'newest first by month: Mar 2024, Aug 2023, Feb 2021');
    assert.ok(built.changes.some(line => /reverse chronological/.test(line)));
    const sourceBullets = parsed.experience.flatMap(entry => entry.bullets);
    for (const entry of built.tailored.experience) for (const line of entry.bullets) assert.ok(sourceBullets.includes(line), `a bullet that is not exactly one of the source bullets: ${line}`);
    assert.ok(built.tailored.experience[0].bullets.length >= 3, 'the newest role keeps its bullets');
    assert.ok(!/### (SQL,|KPIs|CLIs)/.test(renderMarkdown(built.tailored)), 'no fragment of a bullet is a role heading');
});

test('without any dates the entries are still split correctly after each bullet list', () => {
    const entries = parseEntries(['Alpha Project', '• Did the first thing with a measurable result of 20 percent across the team', 'Beta Project', '• Did the second thing', '• Did the third thing']);
    assert.deepEqual(entries.map(entry => [entry.header, entry.bullets.length]), [[['Alpha Project'], 1], [['Beta Project'], 2]]);
});

test('a date range is a date range', () => {
    for (const range of ['March 2024 – June 2024', 'Feb 2021 - Jul 2023', '2019 – Present', 'August 2023 – February 2024']) assert.ok(DATE_RANGE.test(range), range);
});

test('a plain, well-formed resume still reads exactly as before', () => {
    const plain = 'Jordan Rivera\njordan@example.com | (312) 555-0187\n\nSUMMARY\nData analyst.\n\nEXPERIENCE\nData Analyst — Acme Corp, Chicago IL\n2022 - Present\n- Built Tableau dashboards used weekly by 40 managers\n- Wrote SQL pipelines that cut reporting from 5 days to 2\n\nEDUCATION\nB.S. Statistics, State University, 2020\n';
    const read = parseResume(plain);
    assert.deepEqual(read.experience, [{ header: ['Data Analyst — Acme Corp, Chicago IL', '2022 - Present'], bullets: ['Built Tableau dashboards used weekly by 40 managers', 'Wrote SQL pipelines that cut reporting from 5 days to 2'] }]);
    assert.equal(tailorResume({ resumeText: plain, job: { title: 'Analyst', description: 'SQL' }, profile: {} }).factCheck.ok, true);
});

test('a capitals-only heading that is on no list still ends the section above it', () => {
    assert.equal(headingType('RESEARCH & PUBLICATIONS', { known: true }), 'other');
    assert.equal(headingType('RESEARCH & PUBLICATIONS', { known: false }), null, 'but not before any section has been seen');
    assert.equal(headingType('UNIFIED MENTORSHIP', { known: true }), null, 'a company name in capitals is not a heading');
    const text = ['JANE Q EXAMPLE', 'jane@example.com | (312) 555-0101', 'EXPERIENCE', 'Analyst | Acme', 'March 2024 – June 2024', '• Built dashboards used by 40 managers every week', 'RESEARCH & PUBLICATIONS', 'Paper on dashboard adoption | Journal of Examples', '• Co-authored the study'].join('\n');
    const read = parseResume(text);
    assert.equal(read.experience.length, 1);
    assert.deepEqual(read.experience[0].bullets, ['Built dashboards used by 40 managers every week'], 'the publication is not a bullet of the role');
    assert.deepEqual(read.other.map(section => section.title), ['RESEARCH & PUBLICATIONS']);
});

test('a role that was read wrongly is reported, and a clean reading reports nothing', () => {
    const { readingIssues } = require('./resume');
    assert.deepEqual(readingIssues(parsed), [], 'the fixture is read cleanly');
    const scrambled = {
        experience: [
            { header: ['Data Analytics Intern | Unified Mentorship', 'March 2024 – June 2024'], bullets: ['Analyzed datasets and produced insights using Python and'] },
            { header: ['SQL, processing 1M+ records with statistical rigor'], bullets: ['Created dashboards'] },
            { header: ['Analyst | Acme'], bullets: [] },
            { header: [], bullets: ['Orphan bullet that belongs nowhere in particular'] },
        ],
    };
    const issues = readingIssues(scrambled).join('\n');
    assert.match(issues, /“SQL, processing 1M\+ records with statistical rigor” has no dates/);
    assert.match(issues, /“Analyst \| Acme” has no bullet points/);
    assert.match(issues, /very short bullet \(“Created dashboards”\)/);
    assert.match(issues, /no role heading/);
    assert.match(readingIssues({ experience: [] })[0], /No work experience was found/);
});

test('a PDF whose bullets have no space after them and whose dates are glued to the location is read correctly', async () => {
    const NL = String.fromCharCode(10);
    const text = [
        'JANE Q EXAMPLE', 'jane@example.com | (312) 555-0101', 'SKILLS',
        'Languages and Data: Python, SQL, R',
        'Analytics and BI: Power BI, Tableau, Excel, forecasting, KPI design, sensitivity analysis, DCF valuation, linear programming, CPM scheduling',
        'ML and AI: scikit-learn, TensorFlow, XGBoost',
        'EXPERIENCE',
        'Data Analytics Intern, Northwind Mentor, Remote (India)Mar 2024 – Jun 2024',
        '•Analyzed 100K+ sales transactions in Power BI and R, surfacing regional trends that contributed to a 10% sales',
        'increase in a targeted customer segment',
        '•Ran A/B tests across multiple campaigns to check hypotheses against statistical evidence',
        'Data Analyst Intern, Contoso Motors, Springfield, IndiaAug 2023 – Feb 2024',
        '•Built Python sales-forecasting models on historical transactions to predict seasonal demand, improving planning and',
        '',
        '•Benchmarked models with MAE, RMSE, and cross-validation to make inventory forecasts more consistent',
        'Intern, Example Steel Plant, Springfield, IndiaJun 2019',
        '•Trained on the cryogenic system; helped put data-driven workflow changes in place that reduced waste and raised',
        'productivity',
        'Intern, Sample Petroleum Limited, Springfield, IndiaMay 2019 – Jun 2019',
        '•Studied fuel production processes and analyzed market trends',
        'EDUCATION', 'Master of Science in Business Analytics, Example University, Chicago, IL Sep 2024 – Jun 2026',
    ].join(NL);
    const p = parseResume(text);
    assert.deepEqual(p.experience.map(e => e.bullets.length), [2, 2, 1, 1]);
    assert.match(p.experience[0].header[0], /^Data Analytics Intern, Northwind Mentor, Remote \(India\) \| Mar 2024 – Jun 2024$/);
    assert.ok(p.experience[0].bullets[0].endsWith('customer segment'), 'a wrapped bullet is one bullet');
    assert.ok(p.experience[2].bullets[0].endsWith('raised productivity'), 'a one-word wrapped line is not a role');
    assert.deepEqual(p.skillGroups.map(g => g.label), ['Languages and Data', 'Analytics and BI', 'ML and AI']);
    assert.ok(p.skillGroups[1].items.includes('DCF valuation') && !p.skills.some(s => /ML and AI/.test(s)), 'wrapped group lines do not swallow the next label');
    const out = await optimizeForAts({ resumeText: text, job: { title: 'Data Analyst', company: 'Acme', description: 'SQL, Python, Tableau, forecasting' }, profile: { full_name: 'Jane Q Example' }, target: 90 });
    assert.equal(out.best.built.factCheck.ok, true);
    assert.equal(out.best.built.pages, 1);
});

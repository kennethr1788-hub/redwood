import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { createHash } from 'node:crypto';
import registry from '../../research/growth-planner-r5/source-registry.json' with { type: 'json' };
import robotsParser from 'robots-parser';

export const GOALS = ['AWARENESS', 'WEBSITE_TRAFFIC', 'LEADS', 'SALES', 'LOCAL_APPOINTMENTS'];
export const CATEGORIES = ['NONE', 'HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES', 'POLITICAL_SOCIAL_ISSUES', 'UNKNOWN'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (v, max = 500, required = false) => {
  if (v == null && !required) return '';
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new Error(`Enter text${required ? ' (required)' : ''} within ${max} characters.`);
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
};
function choice(v, values, fallback) { const value = v ?? fallback; if (!values.includes(value)) throw new Error(`Choose one of ${values.join(', ')}.`); return value; }
function number(v, max, integer = false) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isSafeInteger(v))) throw new Error('Enter a finite nonnegative number within the supported range.');
  return v;
}
export function httpUrl(value) {
  const text = clean(value, 2048);
  if (!text) return '';
  let u; try { u = new URL(text); } catch { throw new Error('Enter an HTTP(S) destination.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Destination must use HTTP(S) without credentials.');
  return u.href;
}
export function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Growth plan input is required.');
  const total = number(raw.totalBudget, 1_000_000);
  if (Math.abs(total * 100 - Math.round(total * 100)) > 1e-7) throw new Error('Budget supports at most two decimal places.');
  const days = number(raw.days, 365, true); if (!days) throw new Error('Duration must be 1–365 days.');
  const input = { totalBudget: total, currency: choice(raw.currency, ['USD'], 'USD'), days, goal: choice(raw.goal, GOALS),
    businessName: clean(raw.businessName, 64, true), category: clean(raw.category, 120, true), geography: clean(raw.geography, 160, true), audience: clean(raw.audience, 240, true),
    url: httpUrl(raw.url), landingPage: httpUrl(raw.landingPage), offer: clean(raw.offer, 240), assets: clean(raw.assets, 1000), organicEvidence: clean(raw.organicEvidence, 2000),
    remarketingAudience: choice(raw.remarketingAudience, ['YES','NO','UNKNOWN'], 'UNKNOWN'), customerList: choice(raw.customerList, ['YES','NO','UNKNOWN'], 'UNKNOWN'),
    retargetingRequested: raw.retargetingRequested === true, specialCategory: choice(raw.specialCategory, CATEGORIES, 'UNKNOWN'),
    primaryChannel: choice(raw.primaryChannel, ['META','GOOGLE_ADS','CHATGPT_ADS','ORGANIC_ONLY'], 'META'), chatgptAvailability: choice(raw.chatgptAvailability, ['YES','NO','UNKNOWN'], 'UNKNOWN') };
  for (const key of ['averageOrderValue','leadValue','conversionRate','contributionMargin']) input[key] = raw[key] == null || raw[key] === '' ? null : number(raw[key], ['conversionRate','contributionMargin'].includes(key) ? 100 : 1_000_000);
  return input;
}
const note = (label, text, sourceIds = []) => ({ label, text, sourceIds });
const heuristic = text => note('PLANNER_HEURISTIC', text, ['lf-allocation']);
const official = id => { const r = registry.rules.find(r => r.sourceId === id); if (!r) throw new Error('Missing research rule'); return note(r.type === 'AVAILABILITY_BOUNDARY' ? 'UNKNOWN' : 'OFFICIAL_GUIDANCE', r.rule, [id]); };
const unknown = text => note('UNKNOWN', text);
const money = cents => `USD ${(cents / 100).toFixed(2)}`;

/** Pure deterministic planning; never fetches a site, invokes a model or accesses an account. */
export function buildPlan(raw, audit = null) {
  const input = normalizeInput(raw), totalCents = Math.round(input.totalBudget * 100);
  const unavailable = input.primaryChannel === 'CHATGPT_ADS' && input.chatgptAvailability !== 'YES';
  const active = totalCents > 0 && input.primaryChannel !== 'ORGANIC_ONLY' && !unavailable;
  const reserveCents = active ? Math.floor(totalCents / 10) : totalCents;
  const paidCents = totalCents - reserveCents;
  const audience = input.remarketingAudience === 'YES' || input.customerList === 'YES';
  const retargetingCents = active && ['META','GOOGLE_ADS'].includes(input.primaryChannel) && audience && input.retargetingRequested && totalCents >= 50000 && paidCents / input.days >= 2000 ? Math.floor(paidCents / 10) : 0;
  const primaryCents = paidCents - retargetingCents;
  const budget = {label:'PLANNER_HEURISTIC', sourceIds:['lf-allocation'], totalCents, currency:input.currency, days:input.days, primaryChannel:active ? input.primaryChannel : 'NONE', primaryCents, retargetingCents, reserveCents, organicCents:0, paidCents, averageDailyCents:paidCents/input.days, campaignCount:active ? 1 : 0, creativeCount:3,
    checkpoints:[...new Set([1, Math.ceil(input.days / 2), input.days])],
    schedule:Array.from({length:input.days},(_,i)=>({day:i+1,primaryCents:Math.floor(primaryCents/input.days)+(i<primaryCents%input.days?1:0),retargetingCents:Math.floor(retargetingCents/input.days)+(i<retargetingCents%input.days?1:0)})) };
  if (primaryCents + retargetingCents + reserveCents !== totalCents) throw new Error('Allocation invariant failed.');
  const warnings = [];
  if (active && paidCents/input.days < 1000) warnings.push('BUDGET_TOO_THIN_FOR_RECOMMENDED_FRAGMENTATION');
  if (input.specialCategory !== 'NONE') warnings.push('SPECIAL_CATEGORY_REVIEW_REQUIRED');
  if (input.specialCategory === 'NONE' && /\b(housing|mortgage|real estate|rental|credit|loan|financial|insurance|investment|hiring|employment|recruit|job|politic|election|voting)\w*/i.test([input.category,input.offer,input.businessName].join(' '))) warnings.push('CATEGORY_MISMATCH_REVIEW_REQUIRED');
  if (unavailable) warnings.push('CHATGPT_ADS_AVAILABILITY_DEPENDENT');
  const destination = input.landingPage || input.url;
  if (!destination) warnings.push('DESTINATION_NOT_SUPPLIED');
  const objectives = {AWARENESS:'Awareness',WEBSITE_TRAFFIC:'Traffic',LEADS:'Leads',SALES:'Sales',LOCAL_APPOINTMENTS:'Leads — appointment inquiry'};
  const cta = {AWARENESS:'Learn more',WEBSITE_TRAFFIC:'Explore the details',LEADS:'Request details',SALES:'View product',LOCAL_APPOINTMENTS:'Ask about appointments'}[input.goal];
  const offer = input.offer || `Explore ${input.businessName} and its ${input.category.toLowerCase()} offering.`;
  const creative = {label:'PLANNER_HEURISTIC',sourceIds:['lf-allocation'],brandName:input.businessName,audience:input.audience,objective:input.goal,offer:input.offer,headline:`Explore ${input.businessName}`,body:offer,cta,destination,assets:input.assets,aspectRatios:['9:16','1:1','4:5'],
    angles:[
      {concept:'spotlight',angle:'Offer and practical value',headline:`Explore ${input.businessName}`,body:offer,cta},
      {concept:'editorial',angle:'Decision support',headline:`Is ${input.businessName} right for you?`,body:`Review the ${input.category.toLowerCase()} details and decide whether the offering fits your needs.`,cta:'See the details'},
      {concept:'signal',angle:'Next step',headline:input.goal==='LOCAL_APPOINTMENTS'?'Plan your next appointment':'Take a closer look',body:`Ask ${input.businessName} about the offering, availability and next steps.`,cta:input.goal==='SALES'?'View options':'Ask a question'}
    ]};
  const section = (title, recommendations) => ({title,recommendations});
  const sections = [
    section('PLAN SUMMARY',[note('USER_INPUT',`${input.businessName} · ${input.category} · ${input.geography} · ${input.audience}. Goal: ${input.goal}. Budget ${money(totalCents)} / ${input.days} days.`),heuristic(active ? `Plan one ${input.primaryChannel} campaign. Account status: NOT CONNECTED.` : 'Organic preparation only; no paid allocation. Unallocated funds remain in reserve.'),unknown('No predicted rankings, citations, leads, sales, CPA or ROAS. Paid readiness requires destination, tracking, category and account review.')]),
    section('WHY THIS OBJECTIVE',[note('USER_INPUT',`Selected goal: ${input.goal}.`),heuristic(`Suggested Meta objective: ${objectives[input.goal]}. ${input.goal==='LOCAL_APPOINTMENTS'?'Count qualified appointment inquiries, then confirmed appointments separately.':'Evaluate the selected outcome, not a substitute engagement metric.'}`),official('meta-objective')]),
    section('BUDGET PLAN',[heuristic(`${money(primaryCents)} primary + ${money(retargetingCents)} eligible retargeting + ${money(reserveCents)} unspent reserve = ${money(totalCents)}. ${budget.campaignCount} paid campaign; no separate testing campaign. Organic media spend $0; labor is not free.`),heuristic(`Paid average ${money(Math.round(budget.averageDailyCents))}/day, rounded for display; the integer-cent day ledger is exact. Check days ${budget.checkpoints.join(', ')}.`),heuristic(retargetingCents ? 'A usable audience was reported and retargeting requested. Validate consent, matchability, minimum size and eligibility before using this optional allocation.' : 'No separate retargeting budget: usable audience, explicit request and sufficient budget/duration must all be present.'),...warnings.filter(w=>w.startsWith('BUDGET')).map(heuristic)]),
    section('META/PAID SOCIAL',[...(input.primaryChannel==='META'?[official('meta-reels'),official('meta-budget'),official('meta-measure'),official('meta-categories')]:[heuristic('Meta is not the selected paid channel; these creative outputs can still support organic preparation.')]),heuristic('For a small budget, keep one campaign/ad set unless an eligible retargeting slice is justified. Use a lifetime envelope if supported; campaign and ad-set budget controls must be verified in the current account. Broad eligible placements are different from unrestricted audience targeting.'),note('USER_INPUT',`Special category: ${input.specialCategory}.`),unknown('Confirm current category, regional restrictions and destination policy before external use. This planner does not determine legal eligibility.'),...warnings.filter(w=>w.includes('CATEGORY')).map(w=>heuristic(`${w}: review selection and targeting; do not infer eligibility from a keyword match.`))]),
  ];
  if (input.primaryChannel==='GOOGLE_ADS') sections.push(section('OPTIONAL GOOGLE ADS',[official('google-objective'),official('google-bid'),official('google-budget'),official('google-tips'),official('google-conversions'),heuristic(`Start with one focused ${input.goal==='AWARENESS'?'video awareness':'Search'} campaign for the selected goal. Review location and search intent. Choose conversion bidding only after appropriate tracking is validated; never treat clicks as sales. This schedule is not a hard Google daily cap.`)]));
  sections.push(
    section('ORGANIC SEO',[official('google-helpful'),official('google-appearance'),official('google-org'),official('google-local'),official('google-software'),heuristic('Choose schema that matches the actual business and visible facts; local location/hours, product price/availability, or software features/pricing as applicable. Do not invent reviews or publish every schema type. Draft one useful audience question and answer with evidence; review media descriptions and mobile usability.')]),
    section('AI DISCOVERY',[official('google-ai'),official('openai-bots'),official('openai-publishers'),official('claude-bots'),official('claude-search'),official('claude-removal'),official('xai-search'),official('xai-citations'),official('xai-boundary'),unknown('Crawler allowance is not indexing, citation or ranking. Live WAF/CDN behavior and external search inclusion remain unknown.')]),
    section('LANDING PAGE CHECKLIST',[heuristic('Match the ad promise to the relevant product/offer page. Check phone-width readability, a clear action, truthful price/terms and a working form or checkout. Review consent and contact details. Do not send traffic to an unreviewed destination.'),note(destination?'USER_INPUT':'UNKNOWN',destination ? `Selected destination: ${destination}`:'No URL supplied. You can save the plan, draft content and seed creative now; add a real reviewed destination before rendering/exporting a campaign.'),...observeAudit(audit,input)]),
    section('CREATIVE BRIEF',[heuristic(`Three meaningful angles: ${creative.angles.map(a=>a.angle).join('; ')}. Review all copy against supplied facts. Produce 9:16, 1:1 and 4:5 variants using the existing Grow layouts.`),note('USER_INPUT',`Offer: ${input.offer||'Not supplied'}; available assets: ${input.assets||'Not supplied'}.`),heuristic('The existing motion render is an 8-second silent draft. Add licensed audio in your editing workflow if preparing Reels; check current safe zones and placement previews before external use. No claim that this local render is platform-approved.')]),
    section('TEST PLAN',[heuristic('Compare distinct offer/value, decision-support and next-step messages. Keep audience, destination and measurement consistent for a useful comparison; a formal randomized A/B test is different from unequal ad delivery. Small-budget results may be inconclusive. Do not create another testing campaign by default.')]),
    section('MEASUREMENT',[heuristic(`Track ${ {AWARENESS:'reach, impressions and frequency',WEBSITE_TRAFFIC:'landing-page visits and engaged visits',LEADS:'qualified inquiries and cost per qualified lead',SALES:'verified purchases, revenue, refunds and contribution',LOCAL_APPOINTMENTS:'qualified inquiries, bookings and attended appointments'}[input.goal] }. Validate event firing and deduplication before interpreting results. Use UTM-tagged links; compare platform attribution to business records. A click is not a conversion.`),unknown('No account, pixel, Search Console, referral or conversion measurements are connected. User-provided notes are not independently observed evidence.')]),
    section('REALLOCATION',[heuristic(`Review days ${budget.checkpoints.join(', ')}. Stop planned spend for broken destinations, invalid tracking or policy problems. Otherwise compare qualified outcomes after attribution lag; retain reserve when evidence is insufficient. Reallocate only after operator review, within the original total. No automatic bid or spend changes.`)]),
    section('ASSUMPTIONS/UNKNOWNS',[note('USER_INPUT',`Remarketing audience: ${input.remarketingAudience}; customer list: ${input.customerList}; existing organic/AI evidence: ${input.organicEvidence||'Not supplied'}.`),unknown('Audience usability, permissions, offer accuracy, tracking quality, ad approval and business outcomes are not verified. No third-party case-study result is a forecast.'),heuristic(`Allocation percentages, thresholds, checkpoint timing, objective mapping and creative angles are ${DISPLAY_NAMES.umbrella} planning policy, not official platform minimums.`)])
  );
  if (input.primaryChannel==='CHATGPT_ADS') sections.find(s=>s.title==='META/PAID SOCIAL').recommendations.push(official('openai-availability'),official('openai-adsbot'),official('openai-copy'),note('USER_INPUT',`ChatGPT Ads availability reported: ${input.chatgptAvailability}.`),unknown('AVAILABILITY_DEPENDENT: current account and regional access must be verified externally. No OpenAI account was checked.'));
  const scenarios = [];
  if (input.averageOrderValue > 0 && input.contributionMargin > 0) scenarios.push(note('USER_INPUT',`SCENARIO, not forecast: AOV ${input.averageOrderValue} × contribution margin ${input.contributionMargin}% gives a contribution-based break-even CPA ceiling of USD ${(input.averageOrderValue*input.contributionMargin/100).toFixed(2)} and ROAS threshold ${(100/input.contributionMargin).toFixed(2)} before other costs. Inputs must cover actual variable costs; exclude fixed costs, refunds or other costs only knowingly.`));
  else if (input.averageOrderValue != null) scenarios.push(note('USER_INPUT',`SCENARIO: AOV ${input.averageOrderValue} is gross revenue per order. Break-even CPA/ROAS is unknown without a positive contribution margin.`));
  if (input.leadValue != null) scenarios.push(note('USER_INPUT',`SCENARIO: user-estimated lead value USD ${input.leadValue}; not a verified profitable CPA ceiling.`));
  if (input.conversionRate != null) scenarios.push(note('USER_INPUT',`SCENARIO: ${input.conversionRate} conversions per 100 comparable visits, using your supplied ${input.conversionRate}% conversion rate. Traffic and future conversion rate are unknown.`));
  sections.find(s=>s.title==='MEASUREMENT').recommendations.push(...scenarios);
  const sourceIds = [...new Set(sections.flatMap(s=>s.recommendations.flatMap(r=>r.sourceIds)))];
  const sources = registry.rules.filter(r=>sourceIds.includes(r.sourceId));
  const utm = creative.angles.map((a,i)=>{let url='';if(destination){url=trackingUrl(destination,{source:active?input.primaryChannel.toLowerCase():'organic',medium:active?'paid':'social',campaign:'grow-'+hash(input).slice(0,8)},a.concept);}return {concept:a.concept,label:'PLANNER_HEURISTIC',destination:url,status:destination?'DRAFT_REVIEW_REQUIRED':'DESTINATION_NOT_SUPPLIED'};});
  const readiness={label:'UNKNOWN',status:'REQUIRES_REVIEW',destination:destination?'USER_SUPPLIED_NOT_VERIFIED':'MISSING',technicalEvidence:audit?.status||'NOT_COLLECTED',tracking:'NOT_CONNECTED',specialCategory:warnings.some(w=>w.includes('CATEGORY'))?'REVIEW_REQUIRED':'USER_DECLARED_NONE',channelAvailability:unavailable?'AVAILABILITY_DEPENDENT':'NOT_VERIFIED'};
  const plan = {schemaVersion:1,readiness,status:'SAVED_PLAN_NOT_PUBLISHED',accountStatus:'NOT CONNECTED',input,budget,creative,sections,scenarios,warnings,utm,sources,auditRunId:audit?.runId||null};
  plan.revision=hash(plan);
  return plan;
}

export function observeAudit(audit,input) {
  if (!audit) return [unknown('No existing Grow audit. Technical and content readiness is UNKNOWN; planning does not launch a crawler.')];
  const notes = [note('OBSERVED_EVIDENCE',`Existing Grow audit ${audit.runId||'legacy'} at ${audit.createdAt||'unknown time'}: ${audit.status}. Bounded snapshot only.`)];
  for (const page of (audit.pages||[]).slice(0,3)) {
    const directives=[page.robotsMeta,page.xRobotsTag].filter(Boolean).join(', ');
    const noindex=/(?:^|[\s,:])(?:noindex|none)(?=$|[\s,;])/i.test(directives);
    const types=[];const scan=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>5)return;if(Array.isArray(v)){for(const n of v.slice(0,30))scan(n,depth+1);}else{if(v['@type'])types.push(...(Array.isArray(v['@type'])?v['@type']:[v['@type']]));if(v['@graph'])scan(v['@graph'],depth+1);}};scan(page.jsonLd);
    notes.push(note('OBSERVED_EVIDENCE',`${page.url}: HTTP ${page.status}; ${noindex?'noindex/none observed':'no noindex observed in collected directives (not proof of indexability)'}; title ${page.title?'present':'absent'}; description ${page.description?'present':'absent'}; canonical ${page.canonical||'not observed'}; structured types ${types.join(', ')||'none observed'}; schema parse issues ${(page.schemaErrors||[]).length}. Snapshot ${page.observedAt||audit.createdAt||'date unknown'}.`));
    notes.push(note('OBSERVED_EVIDENCE',`Content snapshot: ${page.text?`${page.text.length} text characters collected`:'body text not captured'}; ${page.h1?.length||0} H1 headings; social image ${page.og?.image||'not observed'}. Image/video completeness and originality are UNKNOWN; these counts do not establish helpfulness.`));
    notes.push(heuristic(`For ${input.category}, review the captured page against visible local location/hours, product price/availability or software use cases as applicable. Add an original answer to a real question from ${input.audience}; verify factual images/video and appropriate alt text. Reuse current evidence, not an invented visibility score.`));
  }
  const robots=audit.resources?.robots;
  for (const bot of ['Googlebot','OAI-SearchBot','Claude-SearchBot','Claude-User',...(input.primaryChannel==='CHATGPT_ADS'?['OAI-AdsBot']:[])]) {
    let allowed;
    const target=input.landingPage||input.url;
    try {if(robots?.status===200 && typeof robots.body==='string' && target && new URL(robots.url).origin===new URL(target).origin) allowed=robotsParser(robots.url,robots.body).isAllowed(target,bot);} catch { /* A failed or mismatched observation remains unknown. */ }
    notes.push(note(allowed===undefined?'UNKNOWN':'OBSERVED_EVIDENCE',`${bot}: ${allowed===undefined?'UNKNOWN':allowed?'ALLOWED_BY_OBSERVED_ROBOTS':'DISALLOWED_BY_OBSERVED_ROBOTS'} for supplied destination; no inference about WAF access, indexing, citation or rank.`));
  }
  return notes;
}

export function seedCampaign(plan,previous={}) {
  const c=plan.creative;
  return {brandName:c.brandName,summary:c.body,headline:c.headline,body:c.body,cta:c.cta,url:c.destination,color:previous.color||'#caff68',tokens:previous.tokens,assetPath:previous.assetPath,confirmed:false,planRevision:plan.revision,stale:false,provenance:{kind:'growth-plan draft',requiresReview:true},variants:c.angles.map(({concept,headline,body,cta})=>({concept,headline:headline.slice(0,92),body:body.slice(0,240),cta}))};
}
export function updatePlan(project,plan) {
  if (project.growthPlan?.revision!==plan.revision) {
    if(project.campaign)project.campaign={...project.campaign,stale:true,confirmed:false};
    if(project.render)project.render={...project.render,stale:true};
    project.exports=(project.exports||[]).map(e=>({...e,stale:true}));
  }
  project.growthPlan=plan;
  return project;
}
const cell = value => {let text=String(value??'');if(/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
const csv = rows => rows.map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
export function planMarkdown(plan) {
  // User text is rendered as plain preformatted text in UI. Escape Markdown HTML/links in portable prose.
  const plain=s=>String(s).replace(/([\\`*_{}\[\]<>#])/g,'\\$1');
  return `# Growth Plan — ${plain(plan.input.businessName)}\n\nRevision: ${plan.revision}\n\nNOT CONNECTED · EXPORTED is not PUBLISHED.\n\n`+plan.sections.map(s=>`## ${s.title}\n\n`+s.recommendations.map(r=>`- [${r.label}] ${plain(r.text)}${r.sourceIds.length?' (sources: '+r.sourceIds.join(', ')+')':''}`).join('\n')).join('\n\n')+`\n\n## OFFICIAL SOURCES\n\n`+plan.sources.map(r=>`- ${r.sourceId} · ${r.type} · ${r.title} · ${r.url} · retrieved ${r.retrievedAt}. Limits: ${r.limitations}`).join('\n')+'\n';
}
export function planFiles(plan) {
  const section=title=>plan.sections.find(s=>s.title===title)?.recommendations.map(r=>`- [${r.label}] ${r.text} (${r.sourceIds.join(', ')})`).join('\n')||'';
  return {'growth-plan.json':JSON.stringify(plan,null,2)+'\n','growth-plan.md':planMarkdown(plan),
    'budget-plan.csv':csv([['day','currency','primary_cents','retargeting_cents','reserve_cents','label'],...plan.budget.schedule.map(r=>[r.day,plan.input.currency,r.primaryCents,r.retargetingCents,0,'PLANNER_HEURISTIC']),['HELD_RESERVE',plan.input.currency,0,0,plan.budget.reserveCents,'PLANNER_HEURISTIC']]),
    'utm-plan.csv':csv([['concept','label','destination','status'],...plan.utm.map(r=>[r.concept,r.label,r.destination,r.status])]),
    'source-registry.json':JSON.stringify({schemaVersion:1,planRevision:plan.revision,rules:plan.sources},null,2)+'\n',
    'organic-checklist.md':'# Organic and AI discovery checklist\n\n'+section('ORGANIC SEO')+'\n\n'+section('AI DISCOVERY')+'\n\n'+section('LANDING PAGE CHECKLIST')+'\n',
    'paid-social-brief.md':'# Paid social and creative brief\n\n'+section('META/PAID SOCIAL')+'\n\n'+section('CREATIVE BRIEF')+'\n\n'+section('TEST PLAN')+'\n'};
}

export function trackingUrl(destination,tags,concept){const u=new URL(destination);for(const key of ["source","medium","campaign"])u.searchParams.set("utm_"+key,tags[key]);u.searchParams.set("utm_content",concept);return u.href;}

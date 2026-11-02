// Frequent English function words and everyday vocabulary. This list is deliberately conservative:
// an unknown word requires a card rather than authorizing a potentially invented name.
export const COMMON_WORDS = new Set(`
 able about above across after again against almost along already also although always another answer anyone
anything around away back basic because become been before being below best better between both bring build
call came can case change check child children clear close come common could course current day days different
does done down during each early either else enough even ever every everyone everything example fact family
far feel few find first follow form found four from full further gave general get give given goes going good
great group hand happen hard have having head help here high home however important including into just keep
kind know known large last later least leave left less life like likely little live local long look made make
many matter may mean might more most move much must name near need never new next night nothing now often once
only open order other others otherwise over own part people perhaps place plan point possible present problem
provide public question rather reach read really reason result return right same say second seem seen several
should show side since small some someone something sometimes soon start state still such sure take than that
their them then there these they thing things think this those though thought three through time together too
took true try turn under until upon used useful very want was way well went were what when where whether which
while whole why will with within without word work world would year years your yours you youd youre youve
yourself also always among anyone appear area ask available average based became become begins behind believe
beside between beyond book both bring brought business called cannot care carry certain chance choose clear
clearly comes consider course create days decide decision depending describe details did difference doing easy
end enough especially even ever example explain few find follow following force found getting going great
guide help helpful helps higher history hold idea ideas important include including issue its keep keeping
kind language larger least let level line list little living looking looks lower main making means measure
might money month months morning mostly necessary next number often old once order others our own particular
people perhaps person point process rather read ready real really reasons remember rest right room run same
say says see seem seems send sent set several show shown simple simply single site size small smaller
something source sources space speak specific start started stop such support sure system take taken taking
tell term terms test than thanks then therefore thing think thinking third though today together too top total
try trying type typically understand usually value various view wanted wants way ways week weeks well went
whether whole words work working works would write written year young actually advice allow allows amount
applies apply approach ask based benefits better brings can change changed changes clear clearly consider
current currently data decide decision depends difference different difficult easily easy enough example
examples experience fact facts finding findings first good helpful instead important information involves
issue knowledge likely look makes making matter means might needed needs options outcome perhaps plan plans
possible potentially practical probably question questions rather reason relevant result results risk risks
say should show since solution specific still suggest suggestion suggests support supported sure than there
these they think those thought useful using usually want what when where which while with would your above
accept according account achieve action activity actually add added additional address advantage affect again
against age ago agree air almost alone along amount among analysis and animal another anyone anything appear
approach area arm around arrive article artificial ask attention available avoid baby bank base bear beat
beautiful began begin beginning behavior believe below benefit beside beyond bit black blue body born break
bring brother build built buy call camera campaign capital card career catch cause center central century
chair challenge character charge check choice choose church city class clear close coach cold college color
commercial community company compare computer condition conference consider consumer contain continue control
cost could country couple cover create culture customer dark daughter dead deal death debate decade decide
deep design despite detail determine develop development die dinner direction director discover discuss
discussion disease doctor door down draw dream drive drop drug during each east economic education effect
effort eight election employee energy enjoy enter entire environment environmental especially establish
evening event ever everybody evidence exactly exist expect experience expert explain eye face fact factor fail
fall family famous fast father fear federal feeling field fight figure fill film final finally financial fine
finger finish fire firm fish five floor focus food foot force foreign forget former forward friend front
garden gas girl goal government ground grow growth guess gun guy hair half hand hang happen happy health hear
heart heat heavy help her herself high himself history hit hold holiday hope hospital hot hotel hour house
human hundred husband imagine impact improve include increase indeed indicate individual industry inside
instead institution interest international interview investment involve itself job join jump key kid kill
kitchen land language later laugh law lawyer lead leader learn least least leave legal less letter likely line
listen little local long lose loss lot love low machine magazine maintain major majority manage management
manager market material matter maybe media medical meeting member memory message method middle military
million mind minute mission modern moment month morning mother mouth movement movie music national natural
nature nearly necessary network never news newspaper nice night north note notice number occur offer office
officer official once one onto opportunity option order organization other outside owner page pain painting
paper parent participant particularly partner party pass past patient pattern payment peace performance period
person personal phone physical pick picture piece place player play police policy political politics poor
popular population position positive possible power practice prepare president pressure pretty prevent price
private probably problem process produce product production professional professor program project property
protect prove provide purpose push quality quickly quite race radio raise range rate rather reach read reality
realize receive recent recently recognize record red reduce reflect region relate relationship religious
remain remember remove report represent require research resource respond response responsibility result
return reveal rich rise road rock role room rule safe save school science scientist score season seat section
security seek seem sell send senior sense series serious serve service seven several shake share she shoot
short shot should shoulder show side sign significant similar simple simply since sing sister sit situation
six skill skin sleep small smile social society soldier somebody someone something son song sort sound south
southern space speak special specific speech spend sport spring staff stage stand standard star start state
statement station stay step still stock stop store story strategy street strong structure student study stuff
style subject success successful suddenly suffer suggest summer support system table take talk task tax teach
teacher team technology television tell ten tend term test than thank that their themselves theory there
therefore these they thing think third this those though threat three through throughout throw time tiny today
together tomorrow tonight total tough town trade traditional training travel treat treatment tree trial trip
trouble truth turn two type understand unit until upon us use usual usually value various very victim view
violence visit voice wait walk wall want war watch water way weapon wear week weight western whatever whether
white whole whose why wide wife window wish woman women wonder word work worker world worry would write writer
wrong yard yeah year yes yet young youth`.split(/\s+/u));

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z]{4,}/gu) ?? [];
}

export function hasUnsupportedWords(text: string, basis: string): boolean {
  const allowed = new Set(tokens(basis));
  for (const word of [...allowed]) {
    for (const suffix of ['s', 'es', 'ed', 'ing']) allowed.add(word + suffix);
    if (word.endsWith('e')) {
      allowed.add(`${word}d`);
      allowed.add(`${word.slice(0, -1)}ing`);
    }
  }
  return tokens(text).some(word => !allowed.has(word) && !COMMON_WORDS.has(word));
}

"""Litigation components: court events, orders, chronology, evidence matrix, offers, court book, scenarios."""
from components import comp
from icons import icon
from litigation import *
from markup import *

comp("CourtEvent", "Litigation", 260, """
# CourtEvent

A listing in court or before a mediator: date block, what it is, which matter, and where and how to attend (court and list, courtroom or online link, judicial officer).

Hearings fill the date block blue; everything else stays neutral. Each event carries what must be ready beforehand as its right-hand action (“Brief ready”, “Affidavit filed”). Events come from orders and the court’s online registry and sync to Outlook.
""", '<div class="mt-col" style="width:560px;gap:8px">'
    + court_event("Fri", "9", "Oct", "Registrar’s directions · Doyle v Brennan", "Probate List · 9:30 am · seek timetable for expert evidence", [("external", "Online · Microsoft Teams"), ("court", "NSWSC 2026/00213958")], "directions", badge("Ready", "success"))
    + court_event("Tue", "9", "Mar", "Hearing, 3 days · Doyle v Brennan", "Before a judge · 10:00 am · 9–11 Mar 2027", [("court", "Law Courts Building, Sydney"), ("user", "Counsel: J. Mercer SC")], "hearing", badge("Brief 40%", "warning"))
    + "</div>")

comp("CourtOrder", "Litigation", 250, """
# CourtOrder

One numbered order, as made, with what it turns into: a deadline, a court event, or nothing. Clerk reads orders from the sealed PDF or the online registry and proposes the deadlines. A person confirms them.

Orders whose date depends on something not yet fixed (“within 7 days of the mediation”) are flagged warning and say what they are waiting for. Always show the order’s own words; never paraphrase a court order in place of it.
""", '<div style="width:640px">'
    + order("1", "The plaintiff is to file and serve any affidavit evidence on which she relies by 30 September 2026.", "Deadline · Plaintiff’s evidence", deadline("Overdue 2d", "overdue"))
    + order("4", "The parties are to attend a mediation by 27 November 2026.", "Court event · mediation booked 26 Nov", deadline("26 Nov", "upcoming"))
    + order("5", "The defendant is to notify the Court of the outcome of the mediation within 7 days after it concludes.", "Waiting for the mediation date to be confirmed", badge("Date depends", "warning"), True)
    + "</div>")

comp("ChronologyEvent", "Litigation", 300, """
# ChronologyEvent

A dated fact in a dispute’s chronology, with its source and the issues it bears on. Key events (those the case turns on) fill the pin blue and set the title in medium weight.

Every event cites at least one source document with a pinpoint. Clerk builds the chronology from the file and flags gaps (“no medical evidence between Aug 2023 and Mar 2024”); a person marks events as key and settles the wording. Issue tags use a letter code so they stay readable in print.
""", '<div class="mt-chrono" style="width:640px"><div class="mt-chrono-year">2023</div>'
    + chrono("22 Aug", "Geriatrician diagnoses moderate Alzheimer’s disease; recommends that Harold not manage his own finances.", ["Dr Wong report p 2"], ["cap"], True)
    + chrono("Nov", "Gary Doyle begins daily visits and is given authority over Harold’s Westpac accounts.", ["Westpac authority form", "R. Brennan aff. [14]"], ["ui"])
    + '<div class="mt-chrono-gap">' + suggestion("No medical records between Aug 2023 and Mar 2024", "Clerk · the will was made in this window. Consider a subpoena to Dr Patel for that period.", "Draft subpoena") + "</div></div>")

comp("EvidenceMatrix", "Litigation", 300, """
# EvidenceMatrix

Each issue in dispute broken into the elements that must be proved, the evidence for each, and how strong it currently looks. It is the working list for what to gather next.

Strength is the fee earner’s call (Clerk proposes it with reasons). Gaps are warning and link to the action that would fill them. In a capacity dispute the elements follow Banks v Goodfellow; in family provision they follow the s 60(2) factors.
""", '<div style="width:640px">' + matrix([("Testamentary capacity (Banks v Goodfellow)", [
    ("Understood the nature of making a will", cite("Ainsworth statement p 3") + " " + cite("Dr Wong report p 2"), "moderate"),
    ("Knew the extent of his property", cite("Westpac authority form"), "strong"),
    ("Appreciated the claims of his children", '<span class="t-3">No direct evidence yet</span>', "gap")])]) + "</div>")

comp("OfferCard", "Litigation", 300, """
# OfferCard

A settlement offer, made or received: who, when, which kind (Calderbank letter, offer of compromise under UCPR r 20.26), the amount and terms, and its status with its expiry.

Our offers carry a brand wash. An open offer shows its expiry as a DeadlineChip; expired, rejected and accepted offers show a badge. Offers are without prejudice: they never go into a court book.
""", '<div class="mt-col" style="width:600px;gap:8px">'
    + offer("Our client", "18 Sep", "Offer of compromise · UCPR r 20.26", "$260,000", "Plus costs as agreed or assessed, payable from the estate. Open for 28 days.", deadline("Open until 16 Oct", "soon"), "ours", btn("View letter", "ghost", "sm"))
    + offer("Ho Legal for the defendant", "18 Aug", "Calderbank offer", "$120,000", "Inclusive of costs. Each party otherwise bears their own costs.", badge("Rejected 1 Sep"), "theirs")
    + "</div>")

comp("CourtBookIndex", "Litigation", 320, """
# CourtBookIndex

The court book (tender bundle) as an index: tabs, document numbers, dates, who filed it and the running page range. Pages renumber as documents move.

Privileged and without-prejudice material is struck out with a hatch and never reaches the generated PDF. Clerk checks cross-references (exhibits mentioned in affidavits but missing), duplicates and page order before anyone generates it.
""", '<div style="width:100%;border:1px solid var(--border-default);border-radius:10px;overflow:hidden">' + bundle_table([
    ("3", "Affidavits", [("3.1", "Affidavit of Gary Doyle", "21 Jul 2026", "Plaintiff", "112–131", badge("Filed", "info"), False),
                        ("3.2", "Affidavit of Ruth Brennan", "2 Sep 2026", "Defendant", "132–158", badge("Filed", "info"), False)]),
    ("5", "Correspondence", [("5.1", "Letter Carlisle &amp; Webb to Hale &amp; Price", "14 Aug 2026", "—", "201–203", "", False),
                             ("—", "Without prejudice letter, Hale &amp; Price", "28 Aug 2026", "—", "excluded", badge("Without prejudice", "warning"), True)])]) + "</div>", col=True)

comp("ScenarioBars", "Charts", 260, """
# ScenarioBars

Compares outcomes on one money scale around zero: what the client nets under each settlement or hearing scenario, after costs. Bars share the brand hue; a loss sits left of the zero line and its value is labelled in danger text.

Scenarios are estimates from the matter’s costs data, with the assumptions written under each label. They support a lawyer’s advice and are never shown to a client as a prediction.
""", '<div style="width:640px">' + scenarios([("Accept their $120k", "Inclusive of costs; ours to date $24.5k", 95.5), ("Settle at mediation", "Around $210k plus costs from the estate", 210),
                                               ("Our offer accepted", "$260k plus costs", 260), ("Hearing, claim dismissed", "Our costs to hearing, no costs order", -58)], -80, 280) + "</div>")

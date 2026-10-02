# User guide

Road Track is LubeLogger underneath: records, reminders, the Odometer tab,
settings and the Admin Panel work as
[LubeLogger's documentation](https://docs.lubelogger.com/) describes. This
guide covers what Road Track adds. The garage shows each vehicle as a photo
card, with LubeLogger's Calendar tab hidden.

## Tell it when you bought the vehicle

Most figures need a starting point. In the vehicle's edit form, expand
**Purchase/Sold Information**. **Purchased Date** (LubeLogger's) is where
every lifetime figure starts, and **Odometer at purchase** (Road Track's,
optional) is where distance starts. The price, sale, loan and valuation
fields feed [Finance](#finance). The panel opens by itself while either of
the first two is empty; formats are in
[configuration](configuration.md#vehicle-fields-road-track-adds).

## The Dashboard

Road Track replaces the Dashboard you see on clicking a vehicle. LubeLogger's
own version takes distance from fuel records alone, so a vehicle with no fuel
logged reads zero miles. Road Track reads distance from the odometer readings
on every record and in the Odometer tab.

The range buttons (**12M**, **24M**, **5Y**, and the default **All**) scope
every figure except *Last 12 months*. **Include purchase & finance** appears
when the vehicle has a price or deposit; see [Finance](#finance).

| Tile | Shows |
|---|---|
| Total spend | spend in the range, and the number of records |
| Last 12 months | spend in the last 12 months against the 12 before, as a difference in money |
| Cost per month | spend divided by every calendar month since ownership began (or the range opened), quiet months included |
| Cost per mile, km or hour | spend divided by distance, marked `~` when part of the distance is estimated |
| Distance covered | the distance actually recorded, and the latest odometer reading |

- **The main chart**: *Cumulative* is spend over time, and with a purchase
  price or valuations becomes *Cost of ownership*, adding *Paid for the car*
  and *What it's worth* on the same axis, so you can see the month the car
  became worth less than you had paid. Modelled stretches are dashed. *By
  month* and *By year* stack spend by category; *By category* ranks it.
- **Distance driven** spreads each pair of readings over the days between
  them, leaves months the readings do not cover end to end blank rather than
  zero, and switches to yearly bars past 36 months.
- **Running cost per mile** is lifetime spend over lifetime distance at each
  month's end: a big repair steps it up, later miles bring it down. Its
  opening months are left off, with a count, until 5% of the charted distance
  is covered, so one early invoice cannot set the scale.
- **Spend by system** files each record under the first of fourteen systems,
  from *Cooling* to *Inspection & admin*, that its description or notes
  mention, or under *Other*, and says how many records named more than one.
- **Biggest expenses** lists the eight largest records and **All figures**
  every charted value as text. LubeLogger's **Search records**,
  **Maintenance report** and **Export attachments** stay at the bottom.

The footnote lists what the figures rest on: unreadable records skipped, the
purchase date and earlier records left out, readings set aside, how many
records carry a reading, and whether distance was estimated.

## How the figures are worked out

**Spend** is Service, Repairs, Upgrades, Taxes and Fuel records. Supplies and
other record types are not counted, and Odometer records count only towards
distance.

**The purchase anchor.** A second-hand car often arrives with its previous
owner's service history. If the records reach back twelve years and you have
owned the car for five, 6,000 spent in your five years would read as 42 a
month instead of 100. With a Purchased Date, older records stay in LubeLogger
but leave every figure, and the footnote counts them. A blank Odometer at
purchase is read off the readings either side on a straight line; a typed one
higher than a later reading is flagged and not used. Without a date, figures
start at the oldest record, and the footnote suggests a date when that record
is a year or more older than the first one with a cost.

**Odometer readings are cleaned** before any distance is measured:

1. Several readings on one day, as on an invoice keyed line by line, become
   that day's lower median, always a reading somebody entered. A typed
   Odometer at purchase wins its day.
2. A drop the odometer never climbs back above, and that removing one reading
   would not explain, is a reset (a replaced instrument cluster, a rollover).
   The history is split there and distance is summed per part.
3. Within each part, the longest run that never decreases is kept, so one
   mistyped high reading is set aside instead of swallowing every honest
   reading after it.

*Odometer now* is the latest reading that survives.

**Estimated distance.** If readings cover only part of the ownership,
dividing all the spend by the recorded distance overstates the cost per mile.
With at least two months of readings, the missing months are filled at the
rate the readings show. The estimate is used only for cost per distance, only
when it adds at least 5%, and is always marked: `~` on the tile, a sentence
in the footnote.

**Units and money** follow LubeLogger: miles or kilometres from your
settings, hours for a vehicle set to *Use Engine Hours*, and the server's
locale for amounts.

## Finance

The Finance tab covers the cheque that bought the car. It needs Purchased
Price or Down payment, and until one is set it lists the fields to fill in.
Its tiles show what the car ends up costing (price plus interest), when the
loan is paid off, the total interest, what has been paid and what is left,
and what the car is worth now. **Paid against value** charts the payments,
with future ones dashed, against the car's value, and **The loan** tabulates
the terms. The chart and the amount paid so far need a Purchased Date.

**The loan** is worked out from the APR and term, not a monthly payment,
because a remembered payment is rounded and would not reproduce the lender's
interest. It is a level-payment schedule with interest rounded each month,
the first instalment the month after purchase, and a last instalment that
brings the balance to exactly zero. With no term, the car counts as bought
outright. For example, 20,000 with a 2,000 deposit at 6% over 36 months gives
36 payments of 547.59 and interest of 1,713.43.

**Value over time.** The purchase price is the first point, each Estimated
values entry another, and the sale price the last, joined by straight lines.
After the last stated value, and before the first when the first is not the
purchase, the line follows a depreciation curve scaled through your figure,
drawn dashed:

- BMW 3 Series, BMW X3, Subaru Forester and Honda CR-V follow year-by-year
  tables read from CarEdge;
- models named in the [iSeeCars 2026 study](https://www.iseecars.com/cars-that-hold-their-value-study)
  use their measured five-year retention;
- other electric vehicles (*Fuel Type: Electric*) use the study's figure for
  electric cars, 42.8% after five years;
- other makes use a make-level estimate, and anything else the study's
  average, 58.2%.

Age comes from the model year, and a curve never falls below 10% of the value
new. A typed valuation always wins and re-anchors the curve, and a sale ends
the line. Modelled values are rounded to the nearest 10. Without a make and
model year, the line stays flat after the last value.

**The Dashboard toggle.** The Dashboard leaves the purchase out by default,
so its figures are running costs. **Include purchase & finance** adds the
deposit and the instalments paid within the selected range (not the whole
loan) to Total spend, Cost per month and the cost per distance with its
chart. It is not remembered between visits.

## Reports

| Report | Contains |
|---|---|
| Routine maintenance | service records: date, odometer, work done, cost |
| Full records | every record and odometer reading |
| Cost summary | total, per month and per distance; spend by category and by system; the ten biggest expenses |

The two lists sort by date or by cost, and unticking **Include prices**
leaves every amount off a history meant for a buyer or a mechanic. **Print /
Save as PDF** uses LubeLogger's own print routine, so the browser's *Save as
PDF* makes the file, on a phone too. Headings repeat on every page, rows
never split, and the page prints dark on white whatever the theme. Reports
start at the purchase date and say so. LubeLogger's own report generator is
still on the Dashboard as **Maintenance report**.

## Collaborators

This is LubeLogger's own sharing panel, given a tab instead of sitting below
the Dashboard's charts. A collaborator sees the vehicle, and anyone who can
edit a vehicle can add others. LubeLogger's other sharing mechanism,
households, is hidden from the menus, though any existing household still
counts.

## Access (administrators)

The **Access** tab on the garage is a grid of accounts against vehicles. A
tick is a collaborator, and a click adds or removes one at once through
LubeLogger's own endpoints, so its rules still apply. Access inherited
through a household shows as **↳** with the parent's name and cannot be
changed here. A second table lists each account's e-mail address, which
single sign-on matches on, and the vehicles it sees.

The tab appears for accounts with LubeLogger's *Is Admin* flag, set in the
Admin Panel. Vehicles are listed as the signed-in account sees them, so only
root sees every vehicle. After a session expires, a click changes nothing
and the page says so.

## Add a receipt

If the instance has a Telegram bot or an e-mail address that files receipts,
the garage and every vehicle page carry an **Add a receipt** button. *Send a
photo* opens the bot, in the Telegram app on a phone, and tells it which
vehicle when started from that vehicle's page. *Forward the email* opens a
message with the vehicle in the subject. Road Track only links to these
services.

## On a phone

Every Road Track tab is in LubeLogger's phone menu as well as the tab bar.
Below 600 px wide, the Dashboard sets its tiles two to a row under a
full-width Total spend, shortens its charts, and lets rows of buttons scroll
sideways. The receipt button sits clear of the iPhone home indicator and is
left off printouts. Added to a home screen, the app is called Road Track.

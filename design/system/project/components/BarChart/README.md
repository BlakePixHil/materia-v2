# BarChart

Columns for a measure over time, horizontal bars for a measure across categories. One series in the brand hue; a solid reference line for a target.

**Marks.** Bars at most 24px thick, 4px rounded at the data end and square at the baseline, always from zero. Gridlines are 1px `border-subtle`; the baseline `border-default`. A target is a solid 1.5px `text-tertiary` line with its label at the right end.

**Labels.** Label only the latest value and the extreme; ticks carry the rest. Text never takes the bar colour. Category labels for matter types carry the type square.

**Interaction.** Every column band is a hover and focus target (`tabindex="0"`, `data-tip`) showing value first, then the label. Every chart has a “View as table” disclosure with the same numbers.

**Never** a second y-axis, never a categorical rainbow. Two measures of different scale become two charts.

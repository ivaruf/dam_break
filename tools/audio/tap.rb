# UI tap: a small dry wooden click, a pencil set down on the drawing board.
# Every menu and toolbar button.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 3.4 do
  sample :elec_wood, rate: 1.6, amp: 0.45, lpf: 110
  use_synth :sine
  play :a5, attack: 0.001, release: 0.04, amp: 0.12
end

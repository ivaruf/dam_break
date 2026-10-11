# A beam taken away: a soft pop and a short falling slide, like pulling a peg.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.0 do
  sample :elec_pop, rate: 0.8, amp: 0.45, lpf: 100
  use_synth :sine
  s = play :c5, note_slide: 0.12, attack: 0.002, release: 0.16, amp: 0.22
  control s, note: :f4
end

# A timber beam set into place: a hollow wooden knock and a little peg tap.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 3.2 do
  sample :elec_wood, rate: 0.75, amp: 0.9, lpf: 100
  sample :drum_tom_lo_soft, rate: 1.6, amp: 0.35, lpf: 90
  sleep 0.07
  sample :elec_wood, rate: 1.1, amp: 0.3, lpf: 105
end

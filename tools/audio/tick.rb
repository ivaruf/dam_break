# Countdown tick, the last five seconds before the flood arrives: a dry,
# clock-like wooden tock. The final second plays it a little higher.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 4.5 do
  sample :elec_wood, rate: 1.25, amp: 0.55
  sample :elec_tick, rate: 0.9, amp: 0.25
end

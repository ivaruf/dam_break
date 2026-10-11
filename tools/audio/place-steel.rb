# A steel girder bolted in: a bright clank with a short ring that dies fast.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 3.4 do
  with_fx :reverb, room: 0.3, mix: 0.15 do
    sample :elec_wood, rate: 0.6, amp: 0.5
    sample :perc_bell, rate: 1.6, amp: 0.3, finish: 0.25, lpf: 112
    use_synth :fm
    play :e5, divisor: 1.414, depth: 2, attack: 0.001, release: 0.35, amp: 0.22
    sleep 0.06
    sample :elec_tick, rate: 0.7, amp: 0.35
  end
end

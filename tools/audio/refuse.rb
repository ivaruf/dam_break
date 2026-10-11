# A placement the rules refuse: two low, muted bumps — a polite "nuh-uh",
# never a buzzer. Fires on the same click the reach circle pulses red or amber.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.8 do
  with_fx :lpf, cutoff: 80 do
    use_synth :tri
    sample :elec_wood, rate: 0.5, amp: 0.22
    play :e3, attack: 0.005, release: 0.09, amp: 0.4
    sleep 0.13
    play :c3, attack: 0.005, release: 0.14, amp: 0.4
  end
end

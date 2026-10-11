# A cable strung taut: a short plucked twang and the click of its clamp.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.6 do
  with_fx :reverb, room: 0.3, mix: 0.2 do
    sample :elec_tick, rate: 0.8, amp: 0.3
    use_synth :pluck
    # Low-passed: the pluck's noise excitation is random per render and can
    # spike far above the note itself.
    with_fx :lpf, cutoff: 96 do
      play :g3, amp: 0.8, release: 0.9
    end
    sample :elec_twang, rate: 1.0, amp: 0.18, lpf: 100
  end
end

# A steel member or a cable giving way: a hard metallic spang, briefly ringing.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.5 do
  with_fx :reverb, room: 0.55, mix: 0.25 do
    sample :drum_snare_hard, rate: 0.8, amp: 0.28, lpf: 100
    sample :perc_bell, rate: 0.9, amp: 0.25, finish: 0.5
    use_synth :fm
    play :c4, divisor: 1.41, depth: 4, attack: 0.001, release: 0.9, amp: 0.32
    sleep 0.05
    s = play :fs5, divisor: 2.6, depth: 1.5, attack: 0.001, release: 0.6, amp: 0.18, note_slide: 0.4
    control s, note: :c5
  end
end

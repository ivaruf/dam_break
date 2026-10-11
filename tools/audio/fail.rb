# The dam gave way: a low, sober falling phrase in B minor. Not a raspberry —
# just "that one got through". About two and a half seconds.
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 2.0 do
  use_bpm 100
  with_fx :reverb, room: 0.7, mix: 0.4 do
    sample :bd_boom, amp: 0.45, rate: 0.9
    use_synth :hollow
    play chord(:b2, :minor), attack: 0.2, sustain: 1.4, release: 2, amp: 0.5
    use_synth :piano
    [[:fs4, 0.75], [:e4, 0.75], [:d4, 0.75], [:b3, 2]].each do |n, d|
      play n, amp: 0.18, hard: 0.25, vel: 0.4, release: d
      sleep d
    end
    sleep 2
  end
end

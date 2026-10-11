# DAM BREAK build theme: "Plans and pegs". 80 bpm, a 64-beat loop played
# twice; the tick and one-beat lead are slicing markers (see music-title.rb).
# Plays while the player builds, free build and countdown alike.
#
# Calm and busy at once: a plucked string ticking through the chords in eighths like
# somebody measuring twice, a woodblock on two and four, a warm bass, a pad
# and, in the second half of each pass, a short piano tune. Nothing in it
# hurries — the hurry belongs to music-flood.rb, which shares this tempo, this
# key and this bar length (3 s) so the game can cut across on the bar.
use_bpm 80
use_random_seed 21
sample :elec_tick, amp: 1.4
sleep 1
chords = [chord(:d3, :major), chord(:b2, :minor), chord(:g2, :major), chord(:a2, :major),
          chord(:d3, :major), chord(:fs2, :minor), chord(:g2, :major), chord(:a2, :sus4)]
in_thread do
  with_fx :reverb, room: 0.8, mix: 0.5 do
    with_fx :lpf, cutoff: 86 do
      use_synth :hollow
      2.times do
        chords.each do |c|
          play c, attack: 1.5, sustain: 4.5, release: 2.5, amp: 0.55
          sleep 8
        end
      end
    end
  end
end
in_thread do
  with_fx :lpf, cutoff: 78 do
    use_synth :bass_foundation
    2.times do
      chords.each do |c|
        r = c[0] - 12
        play r, amp: 0.4, release: 1.8
        sleep 3
        play r, amp: 0.24, release: 0.7
        sleep 1
        play r + 7, amp: 0.3, release: 1.6
        sleep 4
      end
    end
  end
end
in_thread do
  with_fx :reverb, room: 0.6, mix: 0.3 do
    use_synth :pluck
    shape = [0, 2, 1, 3, 2, 1, 3, 2]
    2.times do
      chords.each do |c|
        tones = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24]
        16.times do |k|
          play tones[shape[k % 8]], amp: (k % 4 == 0 ? 1.0 : 0.65), pan: rrand(-0.3, 0.3)
          sleep 0.5
        end
      end
    end
  end
end
in_thread do
  2.times do
    32.times do
      sleep 1
      sample :elec_wood, amp: 0.45, rate: 1.05, lpf: 100
      sleep 1
      sample :elec_wood, amp: 0.32, rate: 1.2, lpf: 100
    end
  end
end
in_thread do
  use_synth :sc808_maracas
  2.times do
    64.times do
      sleep 0.5
      play 60, amp: 0.2
      sleep 0.5
    end
  end
end
# The tune: the last four chords of each pass, falling home to D on the loop.
in_thread do
  with_fx :reverb, room: 0.75, mix: 0.4 do
    use_synth :piano
    tune = [[:a4, 2], [:b4, 1], [:a4, 1], [:fs4, 4],
            [:e4, 2], [:fs4, 1], [:a4, 1], [:cs5, 4],
            [:b4, 2], [:a4, 1], [:g4, 1], [:d5, 4],
            [:e5, 4], [:d5, 4]]
    2.times do
      sleep 32
      tune.each do |n, d|
        play n, amp: 0.18, hard: 0.3, vel: 0.45, release: d * 0.8
        sleep d
      end
    end
  end
end

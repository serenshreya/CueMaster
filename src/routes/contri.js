'use strict';

const express = require('express');
const router  = express.Router();

// Largest-remainder rounding for fair split down to the exact rupee
function largestRemainderSplit(total, n) {
  const base = Math.floor(total / n);
  const remainder = total - (base * n);
  return Array.from({ length: n }, (_, i) => i < remainder ? base + 1 : base);
}

// GET /api/contri/players — list partner matching profiles
router.get('/players', (req, res) => {
  const players = [
    {
      id: 1,
      name: 'Arjun S.',
      gender: 'M',
      elo: 1420,
      role: 'College Student',
      distance: '2 km',
      tags: ['Snooker', 'Pool', 'Friendly'],
      verified: 'Aadhaar Verified',
      note: "Let's play!",
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80'
    },
    {
      id: 2,
      name: 'Diya K.',
      gender: 'F',
      elo: 1285,
      role: 'B.Tech',
      distance: '3 km',
      tags: ['Snooker', 'Pool', 'Chill'],
      verified: 'DigiLocker Verified',
      note: 'Good vibes only',
      avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=300&q=80'
    },
    {
      id: 3,
      name: 'Rohan P.',
      gender: 'M',
      elo: 1560,
      role: 'College Student',
      distance: '4 km',
      tags: ['Snooker', 'Pool', 'Competitive'],
      verified: 'Aadhaar Verified',
      note: 'Game on!',
      avatar: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=300&q=80'
    },
    {
      id: 4,
      name: 'Sneha M.',
      gender: 'F',
      elo: 1560,
      role: 'B.Tech',
      distance: '3 km',
      tags: ['Snooker', 'Pool', 'Beginner'],
      verified: 'DigiLocker Verified',
      note: 'Any table?',
      avatar: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=300&q=80'
    }
  ];

  res.json({ players });
});

// POST /api/contri/split — calculate fair split and return UPI payment links
router.post('/split', (req, res) => {
  const { totalAmount, players, payeeVpa = 'kamuiclub@upi', payeeName = 'KAMUI Club' } = req.body || {};
  const total = Number(totalAmount || 1110);
  const playerList = Array.isArray(players) && players.length > 0 ? players : ['Arjun S.', 'Diya K.', 'Rohan P.', 'Sneha M.'];
  const n = playerList.length;

  const splits = largestRemainderSplit(total, n);

  const results = playerList.map((name, i) => {
    const amt = splits[i];
    const upiLink = `upi://pay?pa=${encodeURIComponent(payeeVpa)}&pn=${encodeURIComponent(payeeName)}&am=${amt}&tn=${encodeURIComponent('Contri Split - ' + name)}&cu=INR`;
    return {
      name,
      amount: amt,
      upiLink,
      qrPayload: upiLink
    };
  });

  res.json({
    total,
    count: n,
    splits: results
  });
});

module.exports = router;

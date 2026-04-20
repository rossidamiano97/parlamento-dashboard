name: Fetch Parliamentary Data

on:
  schedule:
    # Ore 8:00 e 20:00 ora italiana (UTC+2 in estate, UTC+1 in inverno)
    - cron: '0 6,18 * * *'
  workflow_dispatch: # Permette esecuzione manuale dalla schermata Actions

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm install

      - name: Fetch and store parliamentary data
        run: node scripts/fetch-data.js
        env:
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}

      - name: Log completion
        run: echo "Fetch completato alle $(date)"

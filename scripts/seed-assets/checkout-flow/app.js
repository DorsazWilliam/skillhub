// Three steps, live totals. Runs inside the prototype only.
const steps = ['Continue to shipping', 'Continue to payment', 'Pay now'];
let step = 1;

function show() {
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = Number(p.dataset.panel) !== step));
  document.querySelectorAll('[data-step]').forEach((s) => s.classList.toggle('on', Number(s.dataset.step) <= step));
  document.getElementById('next').textContent = steps[step - 1];
  document.getElementById('back').hidden = step === 1;
}

function totals() {
  let sub = 0;
  document.querySelectorAll('.lines li').forEach((li) => {
    const n = Number(li.querySelector('.qty i').textContent);
    const price = li.querySelector('.price');
    const line = n * Number(price.dataset.unit);
    price.textContent = '€' + line;
    sub += line;
  });
  document.getElementById('sub').textContent = '€' + sub;
  document.getElementById('total').textContent = '€' + sub;
}

document.querySelectorAll('.qty button').forEach((b) =>
  b.addEventListener('click', () => {
    const i = b.parentElement.querySelector('i');
    i.textContent = String(Math.max(1, Number(i.textContent) + Number(b.dataset.q)));
    totals();
  }),
);
document.getElementById('next').addEventListener('click', () => {
  if (step === 3) {
    document.getElementById('next').textContent = 'Paid (prototype)';
    return;
  }
  step++;
  show();
});
document.getElementById('back').addEventListener('click', () => {
  step = Math.max(1, step - 1);
  show();
});
show();
totals();
